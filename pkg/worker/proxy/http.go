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

	utilnet "k8s.io/apimachinery/pkg/util/net"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/transport"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/worker/tunnel"
)

// HTTPResponse is the worker-side internal result shape for one
// reverse-proxy HTTP call. Body bytes are chunked onto the gRPC stream
// by tunnel.SendHTTPResponse so heartbeats never get starved.
type HTTPResponse struct {
	Status  int32
	Headers []*proto.HTTPHeader
	Body    []byte
	Error   string
}

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
	sendFn func(requestID string, resp *HTTPResponse)
	// streamCtxFn returns the tunnel's current stream context, so each
	// proxied request can derive its ctx from it. When the tunnel
	// disconnects, in-flight upstream HTTP requests get cancelled
	// instead of hanging on their 60 s timeout. nil-tolerant for tests.
	streamCtxFn func() context.Context
	// k8sCfg + apiClient power the service-proxy HTTP fallback. We
	// dispatch via a normal http.Client (rather than client-go's REST
	// helpers) so we get the upstream's full response headers —
	// Content-Type / Content-Encoding / Set-Cookie / Location are all
	// required for an embedded UI like Grafana to render correctly.
	// rest.HTTPClientFor wires bearer-token auth + TLS, matching the
	// rest of the worker's K8s calls. nil-tolerant for tests.
	k8sCfg    *rest.Config
	apiClient *http.Client
	// apiHost is the parsed apiserver host (scheme + authority) used
	// to build service-proxy URLs without re-parsing per request.
	apiHost *url.URL
	// router holds the cached "use direct dial vs service-proxy"
	// decision; shared with the WebSocket proxy via cmd/worker/main.go
	// so both arrive at the same answer without probing twice. May be
	// nil in tests — in that case the proxy always uses direct dial.
	router *InClusterRouter
}

// NewHTTPProxy builds an HTTPProxy with sensible defaults for the in-cluster
// service traffic this layer carries (a Grafana dashboard load can pull a few
// MB of JSON; static asset fetches are tiny). The send function should be the
// tunnel client's SendHTTPResponse; streamCtxFn should be
// tunnel.Client.StreamContext so request ctx tracks tunnel lifetime.
//
// k8sCfg (optional, nil-tolerant) enables routing for URLs whose host
// ends in `.svc.*` — those go through the K8s API server's service
// proxy instead of direct TCP dial, so the worker can reach in-cluster
// Services without resolving `cluster.local` DNS itself. Required for
// local-dev workers that talk to a remote cluster via kubeconfig +
// SSH tunnel.
func NewHTTPProxy(
	sendFn func(string, *HTTPResponse),
	streamCtxFn func() context.Context,
	k8sCfg *rest.Config,
	router *InClusterRouter,
) *HTTPProxy {
	p := &HTTPProxy{
		client: &http.Client{
			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout: 5 * time.Second,
				}).DialContext,
				// Keep-alive a generous pool of upstream conns per Service.
				// The Monitoring page fans out 22+ parallel PromQL queries
				// to one VM Service; Grafana dashboard loads fire ~30
				// parallel asset requests. The previous per-host=20 made
				// the back half of every fan-out wait on a fresh TLS
				// handshake (≈50ms each on local links, more on cross-
				// region). 100 covers both burst sources without growing
				// per-host steady-state usage (idle conns reap after 90s).
				MaxIdleConns:        200,
				MaxIdleConnsPerHost: 100,
				IdleConnTimeout:     90 * time.Second,
				// Disable response body chunking inside the transport so
				// we can read the whole body in one call before forwarding.
				DisableCompression: false,
			},
			// Hard ceiling per request. Aligns with the server-side
			// proxyTimeout (5 min) so a slow Grafana render or large
			// VL search can complete instead of timing out at the
			// worker first. WebSocket uses a separate dispatch path
			// with no overall timeout.
			Timeout: 5 * time.Minute,
		},
		sendFn:      sendFn,
		streamCtxFn: streamCtxFn,
		k8sCfg:      k8sCfg,
		router:      router,
	}
	// Pre-build the apiserver-bound client once. We DON'T use
	// `rest.HTTPClientFor(k8sCfg)` here because client-go caches its
	// HTTP transport globally by config hash — every K8s call in the
	// worker (p.httpClient for Table API, p.dyn for dynamic ops, plus
	// this apiClient if it shared) would end up multiplexing on a
	// SINGLE HTTP/2 connection to the API server.
	//
	// That's catastrophic when the worker is outside the cluster
	// (kubeconfig / dev mode) and direct-dial to `*.svc.*` fails so
	// service-proxy fallback kicks in: a multi-MB VL log query streams
	// back through the apiserver service-proxy on this connection,
	// saturates the HTTP/2 connection-level flow-control window, and
	// every concurrent direct K8s op (list nodes, list namespaces …)
	// stalls until the streaming request finishes consuming the
	// window. Result: nodes-during-logs appears serialised, even
	// though the gRPC tunnel itself is fairly scheduled and the K8s
	// API server has plenty of headroom.
	//
	// Build a fresh `*http.Transport` so this client gets its own
	// connection pool, then wrap with HTTPWrappersForConfig so
	// bearer-token auth + caching token sources still work (SA token
	// rotation continues to function transparently).
	if k8sCfg != nil {
		hostURL, err := url.Parse(k8sCfg.Host)
		if err != nil {
			log.Printf("[http-proxy] parse api host failed (service-proxy fallback disabled): host=%s err=%v", k8sCfg.Host, err)
		} else if cli, err := newIndependentAPIClient(k8sCfg); err != nil {
			log.Printf("[http-proxy] build api http client failed (service-proxy fallback disabled): err=%v", err)
		} else {
			p.apiClient = cli
			p.apiHost = hostURL
		}
	}
	return p
}

// newIndependentAPIClient builds an `*http.Client` aimed at the K8s
// API server using a freshly-constructed `*http.Transport` — i.e. NOT
// the one client-go would hand back from its global TLS transport
// cache. See the long-form rationale at the only call site
// (NewHTTPProxy) for why this matters.
//
// Replays the relevant bits of `transport.New`:
//   1. Build the TLS config from the rest.Config (CA, client certs,
//      InsecureSkipVerify, ServerName).
//   2. Construct a stock `*http.Transport` with our own dial + pool
//      settings, run it through `utilnet.SetTransportDefaults` to pick
//      up the same HTTP/2 configuration client-go applies (read idle
//      timeout, ping timeout, allow-http2, etc.). This is what gets a
//      fresh, unique HTTP/2 connection on first use.
//   3. Wrap with `transport.HTTPWrappersForConfig` so bearer-token /
//      cert callback authentication continues to apply per request,
//      with the same caching semantics client-go uses (token file
//      reloads, exec plugin invocations, …).
func newIndependentAPIClient(k8sCfg *rest.Config) (*http.Client, error) {
	transportCfg, err := k8sCfg.TransportConfig()
	if err != nil {
		return nil, fmt.Errorf("build transport config: %w", err)
	}
	tlsCfg, err := transport.TLSConfigFor(transportCfg)
	if err != nil {
		return nil, fmt.Errorf("build tls config: %w", err)
	}
	base := utilnet.SetTransportDefaults(&http.Transport{
		TLSClientConfig: tlsCfg,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		// Matches HTTPProxy.client's pool sizing — when this client is
		// the service-proxy fallback for in-cluster Service URLs (dev
		// mode + cluster DNS unreachable), the same Monitoring fan-out
		// of 20+ parallel PromQL queries lands on the K8s API server
		// host. 20 per-host was the bottleneck before; 100 lets a full
		// burst reuse keep-alive connections.
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
	})
	rt, err := transport.HTTPWrappersForConfig(transportCfg, base)
	if err != nil {
		return nil, fmt.Errorf("wrap auth: %w", err)
	}
	return &http.Client{
		Transport: rt,
		// Aligns with the server-side proxyTimeout — a slow Grafana
		// render or large VL search can complete instead of timing out
		// at the worker first. Per-request ctx already enforces a
		// shorter budget where appropriate.
		Timeout: 5 * time.Minute,
	}, nil
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
func (p *HTTPProxy) Handle(requestID string, req *tunnel.HTTPRequest) {
	resp, err := p.do(req)
	if err != nil {
		log.Printf("[http-proxy] dispatch failed: url=%s err=%v", req.URL, err)
		p.sendFn(requestID, &HTTPResponse{
			Status: http.StatusBadGateway,
			Error:  err.Error(),
		})
		return
	}
	p.sendFn(requestID, resp)
}

func (p *HTTPProxy) do(req *tunnel.HTTPRequest) (*HTTPResponse, error) {
	if req.Method == "" || req.URL == "" {
		return nil, errors.New("method and url are required")
	}
	// Defense-in-depth: Server constructs the URL today (FQDN of the
	// in-cluster Service), but if that ever regresses to passing user
	// input through, we don't want this proxy to start dispatching
	// file:// or unix:// requests. Restrict to http(s) explicitly.
	if scheme, ok := schemeOf(req.URL); !ok || (scheme != "http" && scheme != "https") {
		return nil, fmt.Errorf("unsupported url scheme: %s", req.URL)
	}

	// Parent on the tunnel's stream ctx so a disconnect immediately
	// cancels the upstream request rather than letting it run out the
	// 60 s timeout. streamCtxFn is nil-tolerant for tests.
	parent := context.Background()
	if p.streamCtxFn != nil {
		parent = p.streamCtxFn()
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	defer cancel()

	// In-cluster Service URLs have two viable routings: direct DNS
	// dial (cheap, common in-cluster case) or the K8s API server's
	// service-proxy subresource (works from anywhere with kubeconfig).
	// Decision is cached per-Worker via InClusterRouter and shared
	// with the WS proxy.
	if svc := parseInClusterService(req.URL); svc != nil && p.apiClient != nil && p.router != nil {
		return p.doInClusterService(ctx, req, svc)
	}

	return p.doDirect(ctx, req)
}

// doInClusterService dispatches to the cached routing decision or
// probes when the cache is cold. On a cold cache it tries direct DNS
// dial first and falls back to the service-proxy path on DNS
// failures (NXDOMAIN / resolver timeout), then writes whichever path
// succeeded into the cache.
//
// On a cached routingDirect we try direct again but, if it now hits
// a DNS failure, transparently fall back AND flip the cache to
// routingProxy — covers the "Worker started in-cluster, then got
// moved out" reconfig edge case without forcing the operator to
// wait for the 24h TTL.
func (p *HTTPProxy) doInClusterService(
	ctx context.Context, req *tunnel.HTTPRequest, svc *inClusterService,
) (*HTTPResponse, error) {
	switch p.router.Mode() {
	case routingDirect:
		resp, err := p.doDirect(ctx, req)
		if err != nil && isDNSFailure(err) {
			log.Printf("[http-proxy] cached direct routing hit DNS failure, demoting to service-proxy: host=%s err=%v",
				svc.namespace+"/"+svc.name, err)
			p.router.SetMode(routingProxy)
			return p.doViaServiceProxy(ctx, req, svc)
		}
		return resp, err
	case routingProxy:
		return p.doViaServiceProxy(ctx, req, svc)
	}
	// routingUnknown — probe by trying direct first.
	resp, err := p.doDirect(ctx, req)
	if err == nil {
		log.Printf("[http-proxy] in-cluster direct dial works, caching routing=direct (24h TTL)")
		p.router.SetMode(routingDirect)
		return resp, nil
	}
	if !isDNSFailure(err) {
		// Direct dial reached the host but the upstream errored
		// (Service has no endpoints, HTTP 5xx, etc.). That's a real
		// upstream problem, not a routing signal — leave the cache
		// cold so the next request re-probes, surface the error.
		return nil, err
	}
	log.Printf("[http-proxy] in-cluster direct dial failed (DNS), caching routing=service-proxy (24h TTL): host=%s err=%v",
		svc.namespace+"/"+svc.name, err)
	p.router.SetMode(routingProxy)
	return p.doViaServiceProxy(ctx, req, svc)
}

// doDirect runs the standard net/http path with no service-proxy
// indirection. Extracted from do() so doInClusterService can reuse it
// for the "try direct first" probe.
func (p *HTTPProxy) doDirect(ctx context.Context, req *tunnel.HTTPRequest) (*HTTPResponse, error) {
	var body io.Reader
	if len(req.Body) > 0 {
		body = bytes.NewReader(req.Body)
	}
	hreq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, body)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}

	for _, h := range req.Headers {
		if _, hop := hopByHopHeaders[http.CanonicalHeaderKey(h.Name)]; hop {
			continue
		}
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
		if name == "Content-Length" {
			continue
		}
		for _, v := range values {
			headers = append(headers, &proto.HTTPHeader{Name: name, Value: v})
		}
	}
	return &HTTPResponse{
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
// endpoint. Auth + TLS come from the rest.HTTPClientFor-built client
// (cached on p.apiClient) so the worker doesn't need direct network
// reachability to the in-cluster Service — only to the API server.
//
// We dispatch a normal http.Request (rather than client-go's REST
// Request helper) so the full upstream http.Response is available.
// Content-Type / Content-Encoding / Set-Cookie all need to reach the
// browser unmodified for an embedded UI like Grafana to render —
// rest.Request.Do().Raw() exposes only ContentType + status, dropping
// every other header.
//
// Trade-offs vs direct dial: rate-limited by API server, larger
// per-request overhead, but works from anywhere a kubeconfig works.
func (p *HTTPProxy) doViaServiceProxy(
	ctx context.Context,
	req *tunnel.HTTPRequest,
	svc *inClusterService,
) (*HTTPResponse, error) {
	if p.apiClient == nil || p.apiHost == nil {
		return nil, errors.New("service-proxy fallback unavailable: no api client")
	}
	target := url.URL{
		Scheme:   p.apiHost.Scheme,
		Host:     p.apiHost.Host,
		Path:     fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%s/proxy%s", svc.namespace, svc.name, svc.port, ensureLeadingSlash(svc.path)),
		RawQuery: svc.query.Encode(),
	}
	var body io.Reader
	if len(req.Body) > 0 {
		body = bytes.NewReader(req.Body)
	}
	hreq, err := http.NewRequestWithContext(ctx, strings.ToUpper(req.Method), target.String(), body)
	if err != nil {
		return nil, fmt.Errorf("build svc-proxy request: %w", err)
	}
	// Replay non-hop-by-hop headers. Host / Content-Length / Cookie
	// don't make sense through the API proxy (it manages those for
	// us). Authorization is stripped too — rest.HTTPClientFor's
	// transport sets the apiserver bearer token; forwarding the
	// browser's would either be empty or wrong for the apiserver.
	for _, h := range req.Headers {
		canon := http.CanonicalHeaderKey(h.Name)
		if _, hop := hopByHopHeaders[canon]; hop {
			continue
		}
		switch canon {
		case "Host", "Cookie", "Content-Length", "Authorization":
			continue
		case "Accept-Encoding":
			// Strip the browser's Accept-Encoding so Go's transport
			// is free to negotiate gzip itself. The transport then
			// transparently decompresses the response body and strips
			// Content-Encoding from the headers, so we forward
			// plaintext bytes + plaintext Content-Type to the server.
			// Leaving the browser's encoding through would suppress
			// the auto-decompress path → compressed body + no
			// Content-Encoding header reaching the browser → "save
			// as .gz".
			continue
		}
		hreq.Header.Add(h.Name, h.Value)
	}

	hresp, err := p.apiClient.Do(hreq)
	if err != nil {
		return nil, fmt.Errorf("svc-proxy dispatch: %w", err)
	}
	defer hresp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(hresp.Body, proxyMaxRespBytes+1))
	if err != nil {
		return nil, fmt.Errorf("svc-proxy read body: %w", err)
	}
	if int64(len(respBody)) > proxyMaxRespBytes {
		return nil, fmt.Errorf("upstream body exceeds %d bytes", proxyMaxRespBytes)
	}

	// The K8s apiserver service-proxy transport
	// (apimachinery/pkg/util/proxy/transport.go) rewrites text/html
	// response bodies — every URL-valued attribute (<base href>,
	// <script src>, <link href>, <a href>, …) gets the apiserver's
	// service-proxy path prepended. Without undoing it, Grafana's
	// index.html sends the browser hunting for
	// `/api/v1/namespaces/.../services/.../proxy/public/build/…`
	// which our top-level proxy doesn't route → "failed to load
	// application files". Same trick the apiserver uses for the
	// Location header; we reverse it by string-replacing the prefix
	// out of HTML and (defensively) text/css bodies. Limited to
	// content types apiserver actually rewrites so we don't touch
	// binary blobs.
	if isContentTypeRewritten(hresp.Header.Get("Content-Type")) {
		prefix := fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%s/proxy",
			svc.namespace, svc.name, svc.port)
		respBody = bytes.ReplaceAll(respBody, []byte(prefix), nil)
	}

	headers := make([]*proto.HTTPHeader, 0, len(hresp.Header))
	for name, values := range hresp.Header {
		if _, hop := hopByHopHeaders[name]; hop {
			continue
		}
		if name == "Content-Length" {
			continue
		}
		for _, v := range values {
			headers = append(headers, &proto.HTTPHeader{Name: name, Value: v})
		}
	}
	return &HTTPResponse{
		Status:  int32(hresp.StatusCode),
		Headers: headers,
		Body:    respBody,
	}, nil
}

// isContentTypeRewritten reports whether the apiserver service-proxy
// rewrites URLs inside a body with this Content-Type. Upstream only
// rewrites `text/html` today (see apimachinery transport.go), but
// guarding by the type prefix means we won't strip prefixes out of
// JSON / binary asset bodies that happen to contain a colon-port-
// like substring.
func isContentTypeRewritten(ct string) bool {
	if ct == "" {
		return false
	}
	// Trim charset / boundary params: "text/html; charset=utf-8".
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	ct = strings.TrimSpace(strings.ToLower(ct))
	return ct == "text/html"
}

func ensureLeadingSlash(p string) string {
	if p == "" {
		return "/"
	}
	if p[0] != '/' {
		return "/" + p
	}
	return p
}
