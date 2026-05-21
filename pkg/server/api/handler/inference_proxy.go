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
// Streaming:
//   This handler ALWAYS asks the worker for streaming responses
//   (gateway.SendHTTPRequestStream) so vLLM's `stream:true` chunks
//   reach the client with per-token latency. Non-streaming responses
//   (a single chat completion JSON) flow through the same path and
//   arrive as one BodyChunk + BodyEnd — no special case.
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
//   - Not an OpenAI-format adapter — vLLM / SGLang / TGI already
//     serve the OpenAI shape, so we just transparently forward.
//   - Not metered — we don't track tokens / requests against the
//     APIKey beyond LastUsedAt timestamp. Quota is a follow-up.
package handler

import (
	"context"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// inferenceStreamTimeout caps a single proxied call. LLM cold-start
// + long-context generation can run minutes; 10 min is past every
// realistic chat-completion call but still finite. Streaming
// responses get the same budget — when the upstream is genuinely
// hanging we want to release the worker session eventually.
const inferenceStreamTimeout = 10 * time.Minute

// inferenceMaxRequestBytes is the per-call request body ceiling.
// Long-context completions can have multi-MB prompts; 16 MiB covers
// "I pasted a whole book in the system prompt" without enabling
// runaway uploads. The worker tunnel's chunked transport handles
// the on-wire framing, so this is a server-side memory cap only.
const inferenceMaxRequestBytes = 16 << 20

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

		url := "http://" + name + "." + namespace + ".svc." +
			workerClusterDomain(gw, clusterID) + ":" +
			strconv.Itoa(inferenceServicePort) + "/v1" + subPath
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
			log.Printf("[inference-proxy] open stream failed: cluster=%s ns=%s name=%s err=%v",
				clusterID, namespace, name, err)
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		defer stream.Close()

		writeStreamingResponse(c, stream, clusterID, namespace, name)
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
func buildUpstreamInferenceHeaders(c *gin.Context) []*proto.HTTPHeader {
	headers := []*proto.HTTPHeader{}
	ct := c.GetHeader("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	headers = append(headers, &proto.HTTPHeader{Name: "Content-Type", Value: ct})
	if ac := c.GetHeader("Accept"); ac != "" {
		headers = append(headers, &proto.HTTPHeader{Name: "Accept", Value: ac})
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
// closes; the deferred stream.Close() releases the worker session,
// and stream.Chunks gets closed by gateway's unregister-on-disconnect
// or naturally on BodyEnd.
//
// Worker truncation: if BodyEnd carries an error we log it but
// don't try to surface a structured error to the client — at that
// point we've already sent 200 + partial body, and overwriting the
// status is illegal. The client's SDK parser will see truncated SSE
// and error out on its own.
func writeStreamingResponse(c *gin.Context, stream *gateway.HTTPStream, clusterID, namespace, name string) {
	// Worker-side dispatch error: 502 + error body, no streaming.
	if stream.Error != "" {
		log.Printf("[inference-proxy] worker dispatch failed: cluster=%s ns=%s name=%s err=%s",
			clusterID, namespace, name, stream.Error)
		apiErrDetail(c, http.StatusBadGateway, CodeProxyUpstream, stream.Error)
		return
	}

	flusher, _ := c.Writer.(http.Flusher)

	for _, h := range stream.Headers {
		canon := http.CanonicalHeaderKey(h.Name)
		if _, hop := hopByHopHeadersServer[canon]; hop {
			continue
		}
		if canon == "Content-Length" {
			continue
		}
		c.Writer.Header().Add(h.Name, h.Value)
	}
	// Tell intermediaries (nginx-ingress etc.) not to buffer SSE.
	// Harmless for non-streaming JSON. Sets in-place so it survives
	// any later Header().Set call.
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	c.Writer.WriteHeader(int(stream.Status))
	if flusher != nil {
		flusher.Flush()
	}

	for {
		select {
		case chunk, ok := <-stream.Chunks:
			if !ok {
				// Channel closed — BodyEnd arrived. Drain any final
				// error from EndErr (non-blocking; finalize fired it
				// already) and return.
				if endErr := <-stream.EndErr; endErr != nil {
					log.Printf("[inference-proxy] upstream truncated: cluster=%s ns=%s name=%s err=%v",
						clusterID, namespace, name, endErr)
				}
				return
			}
			if _, err := c.Writer.Write(chunk); err != nil {
				// Client gone. stream.Close (deferred) releases the
				// worker session.
				log.Printf("[inference-proxy] client write failed (likely disconnect): cluster=%s ns=%s name=%s err=%v",
					clusterID, namespace, name, err)
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		case <-c.Request.Context().Done():
			// Client disconnected mid-stream. Deferred stream.Close
			// unwires the session; in-flight chunks just get dropped
			// (orphan after takeHTTPStream removed the session).
			return
		}
	}
}
