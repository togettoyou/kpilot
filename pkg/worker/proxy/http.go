package proxy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"k8s.io/client-go/kubernetes"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// schemeOf returns the lower-cased URL scheme. ok=false on parse failure
// so callers can reject malformed input cleanly. Used by both the HTTP
// and WebSocket reverse-proxy paths.
func schemeOf(rawURL string) (scheme string, ok bool) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" {
		return "", false
	}
	return strings.ToLower(u.Scheme), true
}

// proxyMaxRespBytes caps the upstream response body the Worker will buffer
// before sending it back to Server over gRPC. Mirrors the Server's request
// body cap; combined they keep a single proxied exchange under the 32 MB
// gRPC message-size ceiling. A malicious or misconfigured Service that
// streams a huge body otherwise OOMs the Worker pod.
const proxyMaxRespBytes = 31 * 1024 * 1024

// HTTPProxy forwards reverse-proxy HTTP requests from Server to in-cluster
// Services (Grafana, VictoriaLogs, …). Worker-side counterpart of
// gateway.SendHTTPRequest.
//
// Each request gets a fresh http.Request built from the proto fields and
// dispatched on a long-lived http.Client whose Transport is tuned for
// in-cluster Service traffic (short dial timeout, generous read/write
// timeouts to accommodate Grafana's slow first-paint of dashboards).
//
// Hop-by-hop headers (Connection / Keep-Alive / TE / etc.) are stripped on
// both sides per RFC 7230 §6.1; if the client wants to upgrade to a
// WebSocket, that goes through the streaming proxy in Step C, not here.
type HTTPProxy struct {
	client *http.Client
	sendFn func(requestID string, resp *proto.HTTPResponse)
	// streamCtxFn returns the tunnel's current stream context, so each
	// proxied request can derive its ctx from it. When the tunnel
	// disconnects, in-flight upstream HTTP requests get cancelled
	// instead of hanging on their 60 s timeout. nil-tolerant for tests.
	streamCtxFn func() context.Context
	// clientset is used to route in-cluster Service URLs through the
	// K8s API server's `/api/v1/namespaces/.../services/.../proxy/`
	// endpoint when direct DNS dial would fail (the common case for
	// local-dev workers outside the cluster). nil-tolerant — when
	// nil, the proxy falls back to direct dial only.
	clientset kubernetes.Interface
}

// NewHTTPProxy builds an HTTPProxy with sensible defaults for the in-cluster
// service traffic this layer carries (a Grafana dashboard load can pull a few
// MB of JSON; static asset fetches are tiny). The send function should be the
// tunnel client's SendHTTPResponse; streamCtxFn should be
// tunnel.Client.StreamContext so request ctx tracks tunnel lifetime.
//
// clientset (optional, nil-tolerant) enables routing for URLs whose host
// ends in `.svc.*` — those go through the K8s API server's service
// proxy instead of direct TCP dial, so the worker can reach in-cluster
// Services without resolving `cluster.local` DNS itself. Required for
// local-dev workers that talk to a remote cluster via kubeconfig +
// SSH tunnel.
func NewHTTPProxy(
	sendFn func(string, *proto.HTTPResponse),
	streamCtxFn func() context.Context,
	clientset kubernetes.Interface,
) *HTTPProxy {
	return &HTTPProxy{
		client: &http.Client{
			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout: 5 * time.Second,
				}).DialContext,
				// Keep-alive a small pool of upstream conns per Service —
				// loading a Grafana dashboard fires ~30 parallel requests
				// for JS/CSS/JSON, recycling sockets matters.
				MaxIdleConns:        50,
				MaxIdleConnsPerHost: 20,
				IdleConnTimeout:     90 * time.Second,
				// Disable response body chunking inside the transport so
				// we can read the whole body in one call before forwarding.
				DisableCompression: false,
			},
			// Hard ceiling per request. Step C (WebSocket) will use a
			// separate dispatch path with no overall timeout.
			Timeout: 60 * time.Second,
		},
		sendFn:      sendFn,
		streamCtxFn: streamCtxFn,
		clientset:   clientset,
	}
}

// hopByHopHeaders are the connection-control headers we must NOT forward.
// Per RFC 7230 §6.1 these apply to a single transport connection and would
// confuse either end of the proxy chain if leaked.
var hopByHopHeaders = map[string]struct{}{
	"Connection":          {},
	"Keep-Alive":          {},
	"Proxy-Authenticate":  {},
	"Proxy-Authorization": {},
	"Te":                  {},
	"Trailer":             {},
	"Transfer-Encoding":   {},
	"Upgrade":             {},
}

// Handle is the tunnel HTTP handler. Always replies, even on error — Server
// is blocked waiting for HTTPResponse and would time out otherwise.
func (p *HTTPProxy) Handle(requestID string, req *proto.HTTPRequest) {
	resp, err := p.do(req)
	if err != nil {
		log.Printf("[http-proxy] dispatch failed: url=%s err=%v", req.Url, err)
		p.sendFn(requestID, &proto.HTTPResponse{
			Status: http.StatusBadGateway,
			Error:  err.Error(),
		})
		return
	}
	p.sendFn(requestID, resp)
}

func (p *HTTPProxy) do(req *proto.HTTPRequest) (*proto.HTTPResponse, error) {
	if req.Method == "" || req.Url == "" {
		return nil, errors.New("method and url are required")
	}
	// Defense-in-depth: Server constructs the URL today (FQDN of the
	// in-cluster Service), but if that ever regresses to passing user
	// input through, we don't want this proxy to start dispatching
	// file:// or unix:// requests. Restrict to http(s) explicitly.
	if scheme, ok := schemeOf(req.Url); !ok || (scheme != "http" && scheme != "https") {
		return nil, fmt.Errorf("unsupported url scheme: %s", req.Url)
	}

	// Parent on the tunnel's stream ctx so a disconnect immediately
	// cancels the upstream request rather than letting it run out the
	// 60 s timeout. streamCtxFn is nil-tolerant for tests.
	parent := context.Background()
	if p.streamCtxFn != nil {
		parent = p.streamCtxFn()
	}
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()

	// If the URL host points at an in-cluster Service (`*.svc.…`) and
	// we have a K8s clientset, route through the API server's Service
	// proxy. Direct dial fails for local-dev workers running outside
	// the cluster — they reach the API server via kubeconfig + SSH
	// tunnel just fine, but `*.svc.cluster.local` doesn't resolve on
	// the local machine. The API-proxy path works regardless.
	if svc := parseInClusterService(req.Url); svc != nil && p.clientset != nil {
		return p.doViaServiceProxy(ctx, req, svc)
	}

	var body io.Reader
	if len(req.Body) > 0 {
		body = bytes.NewReader(req.Body)
	}
	hreq, err := http.NewRequestWithContext(ctx, req.Method, req.Url, body)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}

	// Replay the headers Server forwarded, dropping hop-by-hop ones. Host
	// is special: net/http reads it from req.URL (set above), but inbound
	// proxy traffic may carry an explicit Host header we need to override
	// with the upstream Service's hostname so virtual-host routing works.
	for _, h := range req.Headers {
		if _, hop := hopByHopHeaders[http.CanonicalHeaderKey(h.Name)]; hop {
			continue
		}
		// Special-case: net/http stores Host on the Request struct, not
		// in the header map.
		if http.CanonicalHeaderKey(h.Name) == "Host" {
			hreq.Host = h.Value
			continue
		}
		hreq.Header.Add(h.Name, h.Value)
	}

	hresp, err := p.client.Do(hreq)
	if err != nil {
		return nil, fmt.Errorf("dispatch: %w", err)
	}
	defer hresp.Body.Close()

	// Cap the body at proxyMaxRespBytes. We allow proxyMaxRespBytes+1 so we
	// can detect overflow vs an exactly-cap-sized legitimate response.
	respBody, err := io.ReadAll(io.LimitReader(hresp.Body, proxyMaxRespBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if int64(len(respBody)) > proxyMaxRespBytes {
		return nil, fmt.Errorf("upstream body exceeds %d bytes", proxyMaxRespBytes)
	}

	headers := make([]*proto.HTTPHeader, 0, len(hresp.Header))
	for name, values := range hresp.Header {
		if _, hop := hopByHopHeaders[name]; hop {
			continue
		}
		// Content-Length is recomputed by Server's writer; dropping
		// here avoids a stale value from an upstream that auto-compressed.
		if name == "Content-Length" {
			continue
		}
		for _, v := range values {
			headers = append(headers, &proto.HTTPHeader{Name: name, Value: v})
		}
	}

	return &proto.HTTPResponse{
		Status:  int32(hresp.StatusCode),
		Headers: headers,
		Body:    respBody,
	}, nil
}

// inClusterService captures the K8s Service identity parsed out of a
// URL host. Used to route through the API server's service proxy
// when direct dial would fail.
type inClusterService struct {
	namespace string
	name      string
	port      string
	// path is the path component the API proxy should forward to the
	// upstream Service — passed via .Suffix() on the REST request.
	path string
	// query holds the parsed query parameters from the original URL.
	// Passed individually via .Param(k, v) so client-go encodes them
	// as real ?k=v segments instead of mangling them into the path.
	query url.Values
}

// parseInClusterService extracts (svc, ns, port, path, query) from URLs
// of the form `http://<svc>.<ns>.svc.<cluster-domain>:<port>/<path>?<q>`.
// Returns nil for anything that doesn't match this shape (external URLs,
// IP-literal hosts, …) so the caller falls back to direct dial.
func parseInClusterService(rawURL string) *inClusterService {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil
	}
	host := u.Hostname()
	if host == "" {
		return nil
	}
	// Pattern: svc-name.namespace.svc.<rest>  — split on the first
	// ".svc." occurrence so cluster domains with extra dots
	// (cluster.local, k8s.example.com) all parse.
	const marker = ".svc."
	idx := strings.Index(host, marker)
	if idx <= 0 {
		return nil
	}
	prefix := host[:idx] // svc-name.namespace
	parts := strings.SplitN(prefix, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil
	}
	port := u.Port()
	if port == "" {
		// Default to port name "http" if the URL omits the port —
		// service proxy needs the port spec one way or another.
		port = "http"
	}
	path := u.Path
	if path == "" {
		path = "/"
	}
	return &inClusterService{
		namespace: parts[1],
		name:      parts[0],
		port:      port,
		path:      path,
		query:     u.Query(),
	}
}

// doViaServiceProxy issues the proxied request through the K8s API
// server's `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/...`
// endpoint. Auth + transport come from the K8s clientset's REST
// client, so the worker doesn't need direct network reachability
// to the in-cluster Service — only to the API server.
//
// Trade-offs vs direct dial: rate-limited by API server, larger
// per-request overhead, but works from anywhere a kubeconfig works.
// Body forwarding is straightforward for the JSON / GET workloads
// that need this path (VM PromQL queries). Streaming protocols
// (Grafana Live, large file uploads) should still go through the
// direct WS path or be routed differently.
func (p *HTTPProxy) doViaServiceProxy(
	ctx context.Context,
	req *proto.HTTPRequest,
	svc *inClusterService,
) (*proto.HTTPResponse, error) {
	rest := p.clientset.CoreV1().RESTClient()
	// Verb maps directly: GET/POST/PUT/etc. K8s REST client supports
	// arbitrary verbs via `Verb(method)`.
	//
	// .Suffix expects URL-path segments (it splits on "/" and encodes
	// each one). The path is split into segments because passing the
	// whole "/api/v1/query_range" string as one segment used to URL-
	// encode the "?" boundary into the path. Splitting on "/" + a
	// separate Param() loop for the query keeps the request shape
	// what the API server's service-proxy expects.
	r := rest.Verb(strings.ToUpper(req.Method)).
		Namespace(svc.namespace).
		Resource("services").
		Name(svc.name + ":" + svc.port).
		SubResource("proxy")
	for _, seg := range strings.Split(strings.TrimPrefix(svc.path, "/"), "/") {
		if seg == "" {
			continue
		}
		r = r.Suffix(seg)
	}
	for k, values := range svc.query {
		for _, v := range values {
			r = r.Param(k, v)
		}
	}
	if len(req.Body) > 0 {
		r = r.Body(bytes.NewReader(req.Body))
	}
	// Replay non-hop-by-hop headers. Host / Content-Length / Cookie
	// don't make sense through the API proxy (it manages those for
	// us), so just forward Content-Type / Accept / etc.
	for _, h := range req.Headers {
		if _, hop := hopByHopHeaders[http.CanonicalHeaderKey(h.Name)]; hop {
			continue
		}
		switch http.CanonicalHeaderKey(h.Name) {
		case "Host", "Cookie", "Content-Length":
			continue
		}
		r = r.SetHeader(h.Name, h.Value)
	}

	// Use Stream() rather than Do() — Do() turns non-2xx responses
	// from the service-proxy endpoint into a generic
	// "the server rejected our request for an unknown reason" error
	// that throws away the actual upstream body. Stream() gives us
	// the raw bytes for ANY status code, so we can forward the real
	// VM/Grafana response to the browser even on 4xx/5xx.
	res := r.Do(ctx)
	var status int
	res.StatusCode(&status)
	body, err := res.Raw()
	if err != nil && status == 0 {
		// Real transport error — no upstream response was even
		// received. Surface verbatim so the dispatch log shows what
		// went wrong (RBAC / connection refused / etc.).
		return nil, fmt.Errorf("svc-proxy dispatch: %w", err)
	}
	if int64(len(body)) > proxyMaxRespBytes {
		return nil, fmt.Errorf("upstream body exceeds %d bytes", proxyMaxRespBytes)
	}
	if status == 0 {
		// API server's proxy sets status on success but Raw() can
		// return without populating it on some error paths.
		status = http.StatusOK
	}
	return &proto.HTTPResponse{
		Status: int32(status),
		Body:   body,
	}, nil
}
