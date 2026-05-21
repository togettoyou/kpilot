// Package handler — model chat reverse proxy (P16-B).
//
// Thin reverse proxy from the browser to an in-cluster inference
// Service's OpenAI-compatible API. URL shape:
//
//   POST /api/v1/clusters/:cluster_id/inference/:namespace/:name/*subpath
//
// gets forwarded as
//
//   <method> http://<name>.<namespace>.svc.<cluster-domain>:8000/v1<subpath>
//
// through the worker tunnel via gw.SendHTTPRequest. We hardcode
// port 8000 because that's the only port the P16-A generator
// exposes; the frontend doesn't need to discover it. The /v1
// prefix matches the OpenAI convention every supported runtime
// (vLLM, SGLang, TGI) speaks.
//
// Streaming note: the current HTTPRequest/HTTPResponse plumbing
// is fully buffered — the worker collects the entire upstream
// response before returning, so vLLM `stream: true` works but
// yields zero live token feedback. For P16-B chat 调试 we accept
// that — short turns finish in a few seconds. True SSE pass-through
// is a P16-C concern (will need extending HTTPResponse with an
// IsStream flag + worker-side framing).
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

// inferenceProxyTimeout is the worker-tunnel deadline for one
// inference call. LLM generation can be slow on cold cache; 5 min
// is roomy for a typical chat-debug turn but still finite so a
// wedged backend can't pile up forever. Tune via env later if
// long-context summarization needs more.
const inferenceProxyTimeout = 5 * time.Minute

// inferenceServicePort matches deploy.containerPort — the single
// port the inference Service exposes. Don't accept a port query
// param; the deploy generator owns this contract, and an open
// port knob would let a caller proxy to arbitrary in-cluster
// ports (auth'd, but still wider than we want).
const inferenceServicePort = 8000

// maxInferenceRequestBytes caps the request body the proxy will
// forward. 2 MiB is far past any reasonable chat prompt (typical
// turn = a few KiB) but keeps a runaway client from blowing up
// the gRPC tunnel. The response side is bounded by the worker's
// HTTPResponse buffer.
const maxInferenceRequestBytes = 2 << 20

// ProxyInference handles POST/GET /api/v1/clusters/:id/inference/
// :namespace/:name/*subpath. Targets the inference Service the
// P16-A generator created; *subpath is appended to the `/v1`
// prefix (so /chat/completions reaches /v1/chat/completions).
func ProxyInference(gw *gateway.GatewayServer) gin.HandlerFunc {
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
		// subPath comes from Gin's wildcard with a leading slash;
		// validate the joined target doesn't escape /v1/ via "..".
		// We don't accept absolute schemes either.
		if strings.Contains(subPath, "..") || strings.Contains(subPath, "://") {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		if _, ok := gw.GetWorker(clusterID); !ok {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}

		body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxInferenceRequestBytes+1))
		if err != nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if len(body) > maxInferenceRequestBytes {
			apiErr(c, http.StatusRequestEntityTooLarge, CodeInvalidRequest)
			return
		}

		// Compose the upstream URL. Use FQDN ".svc.<cluster-domain>"
		// like the plugin proxy — short forms break under custom
		// resolv.conf / DNS sidecars.
		url := "http://" + name + "." + namespace + ".svc." +
			workerClusterDomain(gw, clusterID) + ":" +
			strconv.Itoa(inferenceServicePort) + "/v1" + subPath
		if rq := c.Request.URL.RawQuery; rq != "" {
			url += "?" + rq
		}

		// Headers: only forward Content-Type + Accept. Strip
		// everything else to avoid leaking KPilot session cookies
		// or Authorization tokens into the inference backend. The
		// upstream is single-tenant by deployment, no per-request
		// auth needed (vLLM has API key support but the generator
		// doesn't wire it up).
		headers := []*proto.HTTPHeader{}
		if ct := c.GetHeader("Content-Type"); ct != "" {
			headers = append(headers, &proto.HTTPHeader{Name: "Content-Type", Value: ct})
		} else {
			headers = append(headers, &proto.HTTPHeader{Name: "Content-Type", Value: "application/json"})
		}
		if ac := c.GetHeader("Accept"); ac != "" {
			headers = append(headers, &proto.HTTPHeader{Name: "Accept", Value: ac})
		}

		req := &gateway.HTTPRequest{
			Method:  c.Request.Method,
			URL:     url,
			Headers: headers,
			Body:    body,
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), inferenceProxyTimeout)
		defer cancel()

		resp, err := gw.SendHTTPRequest(ctx, clusterID, req)
		if err != nil {
			log.Printf("[model-chat] gateway send failed: cluster=%s ns=%s name=%s err=%v",
				clusterID, namespace, name, err)
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		if resp.Error != "" {
			log.Printf("[model-chat] worker dispatch failed: cluster=%s ns=%s name=%s err=%s",
				clusterID, namespace, name, resp.Error)
			apiErrDetail(c, http.StatusBadGateway, CodeProxyUpstream, resp.Error)
			return
		}

		// Replay headers selectively: pass Content-Type so the
		// browser knows it's JSON / event-stream; drop hop-by-hop
		// + Content-Length (Gin recomputes).
		for _, h := range resp.Headers {
			canon := http.CanonicalHeaderKey(h.Name)
			if _, hop := hopByHopHeadersServer[canon]; hop {
				continue
			}
			if canon == "Content-Length" {
				continue
			}
			c.Writer.Header().Add(h.Name, h.Value)
		}
		c.Writer.WriteHeader(int(resp.Status))
		_, _ = c.Writer.Write(resp.Body)
	}
}

