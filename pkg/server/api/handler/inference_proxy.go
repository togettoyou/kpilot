// Package handler — OpenAI-compatible inference reverse proxy
// (P16-C).
//
// External clients (curl, OpenAI SDKs, LangChain, etc.) talk to:
//
//   POST /api/v1/clusters/:id/proxy/inference/:namespace/:name/v1/chat/completions
//   Authorization: Bearer kp-sk-...
//
// gets forwarded as
//
//   POST http://<name>.<namespace>.svc.<cluster-domain>:8000/v1/chat/completions
//
// through the worker tunnel. Bearer auth is enforced upstream by
// the BearerAPIKey middleware (api/middleware/bearer_api_key.go).
//
// URL path semantics: this endpoint forwards `*subpath` AS-IS to the
// upstream — including the `/v1` segment. OpenAI SDKs (Python, JS,
// LangChain, etc.) follow the convention `base_url = ".../v1"` and
// then append `/chat/completions` themselves, so the wildcard
// naturally captures `/v1/chat/completions`. The cookie-authed
// playground endpoint (model_chat.go) takes the opposite contract
// — its frontend sends `/chat/completions` without the `/v1`
// prefix and the handler prepends it. They differ because the
// playground is an internal client we control, while this endpoint
// must match what OpenAI clients in the wild expect.
//
// Streaming:
//   This handler ALWAYS asks the worker for streaming responses
//   (gateway.SendHTTPRequestStream) so vLLM's `stream:true` chunks
//   reach the client with per-token latency. Non-streaming responses
//   (a single chat completion JSON) flow through the same path and
//   arrive as one big read from the stream's Body — no special case.
//
//   The HTTP response to the SDK client is whatever the upstream
//   sent — Content-Type comes from upstream (text/event-stream for
//   SSE, application/json for batch), and headers + status are
//   forwarded as-is. We flush after every chunk so EventSource /
//   `for await … of resp.body` consumers see tokens immediately.
//
// What this is NOT:
//   - Not a routing layer (`model` field steering across deployments
//     is P17).
//   - Not an OpenAI-format adapter — vLLM already serves the
//     OpenAI shape, so we just transparently forward.
//   - Not metered — we don't track tokens / requests against the
//     APIKey beyond LastUsedAt timestamp. Quota is a follow-up.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	"github.com/togettoyou/kpilot/pkg/server/api/middleware"
	serverdiag "github.com/togettoyou/kpilot/pkg/server/diag"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var inferenceProxyLog = kplog.L("inference-proxy")

// usageScanner extracts the OpenAI-shape `{prompt_tokens,
// completion_tokens, total_tokens}` block from an inference
// response. It works in two modes:
//
//   - SSE (text/event-stream): per-line scan looking for `data:
//     {…}` chunks containing a `usage` field. vLLM emits this on
//     the very last chunk when the client set
//     `stream_options.include_usage=true`; chunks without it are
//     ignored, and the scanner keeps whatever was last observed.
//   - JSON (application/json): the whole body is one chat-completion
//     response with `usage` at the top level. We buffer up to
//     usageScannerJSONCap bytes and parse at Done().
//
// Writes never error so it can sit behind an io.TeeReader on the
// hot streaming path with zero risk of stalling the response.
type usageScanner struct {
	isStream bool
	// partialLine buffers the trailing bytes of a chunk that
	// didn't end at a `\n` so the next Write can finish the line.
	partialLine []byte
	// whole buffers the non-stream JSON body (capped).
	whole []byte
	// observed holds the most recently seen usage block; nil if
	// no usage has been observed yet.
	observed *usageBlock
}

// usageScannerJSONCap caps how much of a non-stream response body
// we'll hold in memory waiting to parse. 256 KiB is enough for any
// realistic chat completion JSON (typical responses run 1–10 KiB);
// past that we give up on counting tokens for the call to keep
// memory bounded.
const usageScannerJSONCap = 256 * 1024

type usageBlock struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
}

func newUsageScanner(contentType string) *usageScanner {
	return &usageScanner{
		isStream: strings.Contains(
			strings.ToLower(contentType),
			"text/event-stream",
		),
	}
}

// Write implements io.Writer. Never errors — see type-level
// comment.
func (u *usageScanner) Write(p []byte) (int, error) {
	if u.isStream {
		u.feedStream(p)
	} else if len(u.whole) < usageScannerJSONCap {
		remain := usageScannerJSONCap - len(u.whole)
		if remain > len(p) {
			remain = len(p)
		}
		u.whole = append(u.whole, p[:remain]...)
	}
	return len(p), nil
}

func (u *usageScanner) feedStream(p []byte) {
	u.partialLine = append(u.partialLine, p...)
	for {
		i := bytes.IndexByte(u.partialLine, '\n')
		if i < 0 {
			return
		}
		line := u.partialLine[:i]
		u.partialLine = u.partialLine[i+1:]
		// Strip the trailing \r from CRLF.
		if n := len(line); n > 0 && line[n-1] == '\r' {
			line = line[:n-1]
		}
		u.processLine(line)
	}
}

func (u *usageScanner) processLine(line []byte) {
	if !bytes.HasPrefix(line, []byte("data: ")) {
		return
	}
	payload := bytes.TrimSpace(line[len("data: "):])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return
	}
	var obj struct {
		Usage *usageBlock `json:"usage"`
	}
	if err := json.Unmarshal(payload, &obj); err != nil {
		return
	}
	if obj.Usage != nil {
		u.observed = obj.Usage
	}
}

// Done finalises and returns the observed usage block. For
// non-stream responses this is when we actually parse the buffered
// body. Returns nil when no usage could be extracted (third-party
// SDKs that don't send include_usage, response truncated mid-
// stream, body exceeded JSON cap, etc.) — caller treats nil as
// "couldn't count, skip the increment".
func (u *usageScanner) Done() *usageBlock {
	if u.isStream {
		return u.observed
	}
	if len(u.whole) == 0 {
		return nil
	}
	var obj struct {
		Usage *usageBlock `json:"usage"`
	}
	if err := json.Unmarshal(u.whole, &obj); err != nil {
		return nil
	}
	return obj.Usage
}

// inferenceStreamTimeout caps a single proxied call. LLM cold-start
// + long-context generation can run minutes; 10 min is past every
// realistic chat-completion call but still finite. Streaming
// responses get the same budget — when the upstream is genuinely
// hanging we want to release the worker session eventually.
const inferenceStreamTimeout = 10 * time.Minute

// inferenceWriteTimeout is the per-chunk Write deadline. Mirrors
// sseWriteTimeout in sse.go; see that comment for the full
// rationale (browser stops reading but keeps TCP keep-alive open →
// kernel send buffer fills → Write blocks forever → handler stuck
// → gateway recv loop blocks → cascade). 5 s is generous for any
// healthy chunk write.
const inferenceWriteTimeout = 5 * time.Second

// inferenceMaxRequestBytes is the per-call request body ceiling.
// Long-context completions can have multi-MB prompts; 16 MiB covers
// "I pasted a whole book in the system prompt" without enabling
// runaway uploads. Bytes flow through the yamux stream as raw
// bytes after the HTTPRequestStart frame, so this is a server-side
// memory cap only.
const inferenceMaxRequestBytes = 16 << 20

// ensureStreamIncludeUsage rewrites a chat-completion request body
// so that `stream_options.include_usage` is true whenever `stream`
// is true. Used by the proxy layer to guarantee vLLM emits the
// terminal `data: { … "usage": {...} }` SSE chunk that the usage
// scanner needs for APIKey metering.
//
// Conservative semantics:
//   - Non-streaming requests pass through unchanged (the usage
//     block is always in the JSON body for those).
//   - When the operator's body already pins
//     include_usage=true OR include_usage=false, we don't override
//     — false is a deliberate opt-out (cost?) we shouldn't ignore.
//     Only the "field absent" case gets backfilled.
//   - Anything that doesn't decode as a JSON object passes through
//     (we can't safely edit it; the proxy will still forward the
//     bytes and metering just won't count tokens for that call).
func ensureStreamIncludeUsage(body []byte) []byte {
	var top map[string]any
	if err := json.Unmarshal(body, &top); err != nil {
		return body
	}
	streaming, _ := top["stream"].(bool)
	if !streaming {
		return body
	}
	var opts map[string]any
	if existing, ok := top["stream_options"].(map[string]any); ok {
		opts = existing
		// Already set — respect the client's intent.
		if _, present := opts["include_usage"]; present {
			return body
		}
	} else {
		opts = map[string]any{}
	}
	opts["include_usage"] = true
	top["stream_options"] = opts
	out, err := json.Marshal(top)
	if err != nil {
		return body
	}
	return out
}

// ProxyInferenceOpenAI is the Bearer-authed external inference
// reverse proxy. Differs from ProxyInference (P16-B cookie-authed
// playground proxy) in three ways:
//
//  1. Always streams the response via gateway.SendHTTPRequestStream
//     — the cookie-auth playground version was buffered (now also
//     uses streaming; see P16-B refactor in model_chat.go).
//  2. URL shape includes a fixed `/proxy/` segment to disambiguate
//     from the playground path.
//  3. Auth is Bearer-only; no cookie fallback.
func ProxyInferenceOpenAI(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		serverdiag.InferenceInflight.Add(1)
		defer serverdiag.InferenceInflight.Add(-1)
		serverdiag.InferenceTotal.Add(1)
		clusterID := c.Param("id")
		namespace := c.Param("namespace")
		name := c.Param("name")
		subPath := c.Param("subpath")
		if clusterID == "" || namespace == "" || name == "" {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if subPath == "" {
			subPath = "/"
		}
		if strings.Contains(subPath, "..") || strings.Contains(subPath, "://") {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if _, ok := gw.GetWorker(clusterID); !ok {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}

		body, err := io.ReadAll(io.LimitReader(c.Request.Body, inferenceMaxRequestBytes+1))
		if err != nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if int64(len(body)) > inferenceMaxRequestBytes {
			apiErr(c, http.StatusRequestEntityTooLarge, CodeInvalidRequest)
			return
		}

		// Force-enable stream_options.include_usage when the client
		// asked for streaming. Without it, vLLM omits the final
		// usage chunk and our usageScanner never
		// observes a `usage` block — APIKey token columns would stay
		// 0 even on active keys. The KPilot playground sets this
		// flag itself, but third-party SDKs (openai-python before
		// it became default, langchain, raw curl) don't — and we
		// own the proxy layer here, so we can backfill silently.
		// Only rewrite when stream=true; non-streaming responses
		// always carry usage in the body and don't need this flag.
		body = ensureStreamIncludeUsage(body)

		// subPath includes the `/v1` segment from the client URL (see
		// package doc). Forward it AS-IS — adding `/v1` here would
		// double the prefix to `/v1/v1/...` and vLLM 404s.
		url := "http://" + name + "." + namespace + ".svc." +
			workerClusterDomain(gw, clusterID) + ":" +
			strconv.Itoa(inferenceServicePort) + subPath
		if rq := c.Request.URL.RawQuery; rq != "" {
			url += "?" + rq
		}

		headers := buildUpstreamInferenceHeaders(c)

		req := &gateway.HTTPRequest{
			Method:         c.Request.Method,
			URL:            url,
			Headers:        headers,
			Body:           body,
			StreamResponse: true,
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), inferenceStreamTimeout)
		defer cancel()

		stream, err := gw.SendHTTPRequestStream(ctx, clusterID, req)
		if err != nil {
			inferenceProxyLog.Warnf("open stream failed: cluster=%s ns=%s name=%s err=%v",
				clusterID, namespace, name, err)
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		defer stream.Close()

		usage := writeStreamingResponse(c, stream, clusterID, namespace, name)

		// Per-call metering: bump RequestCount on every authenticated
		// call (so an operator sees raw call frequency even without
		// usage), and bump token columns when the upstream actually
		// returned a usage block. Async — observability shouldn't
		// block the response.
		if keyID := middleware.APIKeyID(c); keyID != 0 {
			var prompt, completion int64
			if usage != nil {
				prompt = usage.PromptTokens
				completion = usage.CompletionTokens
			}
			go func(id uint, p, comp int64) {
				if err := store.IncrementAPIKeyUsage(id, p, comp, 1); err != nil {
					inferenceProxyLog.Warnf("usage increment failed: keyID=%d err=%v",
						id, err)
				}
			}(keyID, prompt, completion)
		}
	}
}

// buildUpstreamInferenceHeaders selects the request headers worth
// forwarding upstream. Inference backends don't need any KPilot
// session cookie / Bearer token (the auth ended at our middleware),
// and we deliberately strip Authorization to prevent leaking the
// KPilot API key into the model image's logs.
//
// Content-Type + Accept come from the client. Accept-Encoding is
// dropped so Go's transport handles compression auto-decompressing;
// otherwise the worker would forward gzip bytes with no
// Content-Encoding header and the client SDK would mangle them.
func buildUpstreamInferenceHeaders(c *gin.Context) []*pbv2.HTTPHeader {
	headers := []*pbv2.HTTPHeader{}
	ct := c.GetHeader("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	headers = append(headers, &pbv2.HTTPHeader{Name: "Content-Type", Value: ct})
	if ac := c.GetHeader("Accept"); ac != "" {
		headers = append(headers, &pbv2.HTTPHeader{Name: "Accept", Value: ac})
	}
	return headers
}

// writeStreamingResponse drains the gateway HTTPStream into the
// browser / SDK client. Header propagation rules:
//   - Hop-by-hop + Content-Length stripped (Go's ResponseWriter handles
//     chunked encoding automatically).
//   - Every other upstream header passes through, including
//     Content-Type (so SSE arrives with text/event-stream, JSON with
//     application/json).
//
// After each chunk we Flush() — without it, Go's ResponseWriter
// buffers up to ~4 KiB and SSE clients see batched bursts instead
// of per-token delivery.
//
// Client disconnect: c.Request.Context() cancels when the TCP conn
// closes; the deferred stream.Close() FINs the yamux stream, worker
// cancel-watcher fires, upstream HTTP ctx cancels, upstream conn is
// torn down. stream.Body's Read returns an error → io.Copy exits.
//
// Worker truncation: if io.Copy returns an error mid-stream we log
// it but don't try to surface a structured error to the client — at
// that point we've already sent 200 + partial body, and overwriting
// the status is illegal. The client's SDK parser will see truncated
// SSE and error out on its own.
func writeStreamingResponse(c *gin.Context, stream *gateway.HTTPStream, clusterID, namespace, name string) *usageBlock {
	// Worker-side dispatch error: 502 + error body, no streaming.
	if stream.Error != "" {
		inferenceProxyLog.Warnf("worker dispatch failed: cluster=%s ns=%s name=%s err=%s",
			clusterID, namespace, name, stream.Error)
		apiErrDetail(c, http.StatusBadGateway, CodeProxyUpstream, stream.Error)
		return nil
	}

	flusher, _ := c.Writer.(http.Flusher)
	// Per-write deadline — same safety valve as sse.go::send. Browser
	// fetch + AbortController doesn't always close TCP immediately
	// (keep-alive reuse, mid-stream consumer abort path may leave the
	// conn half-open); without this, c.Writer.Write blocks on a full
	// kernel send buffer that never drains, wedging the handler
	// indefinitely. 5 s is plenty for any healthy write; on stall it
	// surfaces fast and the deferred stream.Close → yamux FIN to
	// worker → worker's next upstream-body forward fails → upstream
	// ctx cancels → upstream request torn down.
	rc := http.NewResponseController(c.Writer)

	for _, h := range stream.Headers {
		canon := http.CanonicalHeaderKey(h.Name)
		if _, hop := hopByHopHeadersServer[canon]; hop {
			continue
		}
		if canon == "Content-Length" {
			continue
		}
		// Cache-Control gets a forced rewrite below; don't forward
		// the upstream value here or Add would create a duplicate
		// header pair and intermediaries pick whichever they like.
		if canon == "Cache-Control" {
			continue
		}
		c.Writer.Header().Add(h.Name, h.Value)
	}
	// CRITICAL for streaming pass-through to survive every
	// compression / transformation middleware on the path:
	//
	// - `no-transform` is the documented RFC 7234 §5.2 opt-out.
	//   umi / webpack-dev-server's bundled `compression` package
	//   short-circuits on Cache-Control: no-transform (it calls
	//   it `shouldTransform`); nginx's `gzip_proxied` also honors
	//   it. Without it, the dev proxy gzip-buffers the whole SSE
	//   response and collapses per-token chunks into one final
	//   flush — exactly the bug we just chased.
	// - `no-cache` keeps shared caches from coalescing a
	//   long-lived response.
	// We override unconditionally rather than appending to
	// upstream's Cache-Control (vLLM sends `no-cache, private`)
	// so no value ordering surprise can drop no-transform.
	c.Writer.Header().Set("Cache-Control", "no-cache, no-transform")
	// Tell nginx-style proxies not to buffer SSE. Harmless on
	// non-nginx paths.
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	c.Writer.WriteHeader(int(stream.Status))
	if flusher != nil {
		flusher.Flush()
	}

	// v2: stream.Body is the live yamux byte stream. ctx cancellation
	// becomes a stream.Close (RST → worker's upstream HTTP request is
	// cancelled), which makes the in-flight Read return an error and
	// the loop exits cleanly. The watcher goroutine + deferred Close
	// are idempotent.
	doneClose := make(chan struct{})
	defer close(doneClose)
	go func() {
		select {
		case <-c.Request.Context().Done():
			stream.Close()
		case <-doneClose:
		}
	}()

	// Side-channel usage scanner — observes the same bytes flowing
	// to the client to fish out the `{prompt_tokens, completion_
	// tokens, total_tokens}` block. Returned to the caller for
	// per-key counter increment.
	ct := ""
	for _, h := range stream.Headers {
		if http.CanonicalHeaderKey(h.Name) == "Content-Type" {
			ct = h.Value
			break
		}
	}
	scanner := newUsageScanner(ct)

	buf := make([]byte, 32*1024)
	for {
		n, rerr := stream.Body.Read(buf)
		if n > 0 {
			// Sniff first so partial-write failures still account.
			_, _ = scanner.Write(buf[:n])
			_ = rc.SetWriteDeadline(time.Now().Add(inferenceWriteTimeout))
			if _, werr := c.Writer.Write(buf[:n]); werr != nil {
				// Client closed the connection mid-stream — the common
				// happy path for chat/SSE (user stopped, navigated away,
				// got their answer). Not a server-side problem.
				inferenceProxyLog.Debugf("client write failed (likely disconnect): cluster=%s ns=%s name=%s err=%v",
					clusterID, namespace, name, werr)
				return scanner.Done()
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			if rerr != io.EOF {
				// Non-EOF read termination — could be upstream cancel,
				// worker disconnect, or yamux close. Info, not warn:
				// by the time we see this the inference reply is what
				// it is and there's nothing to react to.
				inferenceProxyLog.Infof("upstream read ended: cluster=%s ns=%s name=%s err=%v",
					clusterID, namespace, name, rerr)
			}
			return scanner.Done()
		}
	}
}
