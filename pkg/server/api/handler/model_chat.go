// Package handler — model chat reverse proxy (P16-B, upgraded by P16-C).
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
// through the worker tunnel via gateway.SendHTTPRequestStream. We
// hardcode port 8000 because that's the only port the P16-A
// generator exposes; the frontend doesn't need to discover it. The
// /v1 prefix matches the OpenAI convention every supported runtime
// (vLLM, SGLang, TGI) speaks.
//
// Auth: JWT cookie (Auth middleware in router.go). This handler is
// the cookie-authed counterpart to the Bearer-authed
// inference_proxy.go::ProxyInferenceOpenAI — both share
// writeStreamingResponse via the gateway streaming primitives.
//
// P16-C swapped this from the buffered SendHTTPRequest path to
// SendHTTPRequestStream so the playground sees real per-token SSE
// from vLLM `stream: true`. Frontend ModelChat consumes the
// response via fetch's ReadableStream + TextDecoder pair.
package handler

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	serverdiag "github.com/togettoyou/kpilot/pkg/server/diag"
	"github.com/togettoyou/kpilot/pkg/server/gateway"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var modelChatLog = kplog.L("model-chat")

// inferenceProxyTimeout is the worker-tunnel deadline for one
// inference call. LLM generation can be slow on cold cache; 10 min
// matches the OpenAI-compat external proxy budget so the two paths
// share lifetime semantics. Tune via env later if long-context
// summarization needs more.
const inferenceProxyTimeout = 10 * time.Minute

// inferenceServicePort matches deploy.containerPort — the single
// port the inference Service exposes. Don't accept a port query
// param; the deploy generator owns this contract, and an open
// port knob would let a caller proxy to arbitrary in-cluster
// ports (auth'd, but still wider than we want).
const inferenceServicePort = 8000

// maxInferenceRequestBytes caps the request body the proxy will
// forward. 2 MiB is far past any reasonable chat prompt (typical
// turn = a few KiB) but keeps a runaway client from filling the
// yamux stream window. The response side flows live via the
// stream's Body io.Reader and isn't subject to this cap.
const maxInferenceRequestBytes = 2 << 20

// ProxyInference handles POST/GET /api/v1/clusters/:id/inference/
// :namespace/:name/*subpath. Targets the inference Service the
// P16-A generator created; *subpath is appended to the `/v1`
// prefix (so /chat/completions reaches /v1/chat/completions).
func ProxyInference(gw *gateway.GatewayServer) gin.HandlerFunc {
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

		req := &gateway.HTTPRequest{
			Method:         c.Request.Method,
			URL:            url,
			Headers:        buildUpstreamInferenceHeaders(c),
			Body:           body,
			StreamResponse: true,
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), inferenceProxyTimeout)
		defer cancel()

		stream, err := gw.SendHTTPRequestStream(ctx, clusterID, req)
		if err != nil {
			modelChatLog.Warnf("gateway open stream failed: cluster=%s ns=%s name=%s err=%v",
				clusterID, namespace, name, err)
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		defer stream.Close()

		writeStreamingResponse(c, stream, clusterID, namespace, name)
	}
}

