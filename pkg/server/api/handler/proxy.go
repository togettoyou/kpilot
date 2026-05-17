package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// proxiableService is the in-cluster Service identity for a reverse-proxy-
// enabled plugin. The release namespace comes from the ClusterPlugin row at
// request time (so the user can override it via the Enable drawer).
type proxiableService struct {
	// Service name as produced by the chart's templates when installed
	// with our conventional release name (= plugin name).
	Service string
	// Cluster-internal port the Service exposes its UI on.
	Port int
}

// proxiableServices is the closed set of plugins KPilot's reverse proxy
// will forward to. Adding a new plugin means: (1) its chart must support
// embedding (sub-path / X-Frame-Options), and (2) we must know the Service
// name + port the chart produces with our standard release name.
//
// Keep this list short and explicit — proxying arbitrary plugins would
// pierce K8s RBAC isolation in surprising ways.
var proxiableServices = map[string]proxiableService{
	"grafana": {Service: "grafana", Port: 80},
}

// defaultClusterDomain is the fallback in-cluster DNS suffix used when the
// connected Worker didn't report one (older worker, registration race). The
// CoreDNS default is "cluster.local"; clusters with a custom domain need a
// matching CLUSTER_DOMAIN env var on the Worker side, which gets shipped up
// to Server in RegisterRequest.
const defaultClusterDomain = "cluster.local"

// workerClusterDomain reads the cluster's reported DNS suffix from the live
// Worker connection, falling back to "cluster.local" when the worker is
// gone (the upstream call will fail anyway, but at least the URL parses).
func workerClusterDomain(gw *gateway.GatewayServer, clusterID string) string {
	if w, ok := gw.GetWorker(clusterID); ok && w.ClusterDomain != "" {
		return w.ClusterDomain
	}
	return defaultClusterDomain
}

// Plugin resolve + cache + invalidation moved to plugin_resolve.go so
// the VM-query handlers (device-health / gpu-hour / gpu-metrics) and
// the reverse proxy share the same DB lookup + 30s TTL cache.

// proxyMaxBodyBytes caps inbound request bodies forwarded through the gRPC
// tunnel. The gRPC layer's hard ceiling is 32 MB; leave 1 MB of headroom for
// HTTPRequest envelope/headers so we never get a ResourceExhausted at the
// other end.
const proxyMaxBodyBytes = 31 * 1024 * 1024

// proxyTimeout is the upper bound on a single proxied HTTP exchange end-to-end
// (Server reads body → Worker dispatches → response returns). Generous because
// Grafana's first dashboard render fans out to many JSON queries; tightened
// later if it bites.
const proxyTimeout = 60 * time.Second

// proxyConcurrency caps in-flight HTTP proxy requests per cluster. A Grafana
// dashboard load fans out to 30+ parallel asset requests; with multiple
// users open the worker's outbound HTTP pool would otherwise saturate and
// late panels stall. 20 keeps a single user under the cap while still
// allowing real parallelism. The semaphore is per (cluster, sem instance),
// not global, so one busy cluster can't starve others.
const proxyConcurrency = 20

// perClusterSemaphore holds bounded-channel semaphores keyed by clusterID.
// Created lazily on first use; never reaped (a few dozen entries is the
// practical upper bound — clusters table is small).
var (
	proxySemMu    sync.Mutex
	proxySemBySys = make(map[string]chan struct{})
)

// DropProxySemaphore removes the per-cluster semaphore entry. Called
// when a cluster is deleted so the map doesn't accumulate dead keys
// across the server's lifetime. Inflight callers holding the buffer
// keep their slot until release; the next acquire will lazily create
// a fresh semaphore if the cluster id were ever reused.
func DropProxySemaphore(clusterID string) {
	proxySemMu.Lock()
	delete(proxySemBySys, clusterID)
	proxySemMu.Unlock()
}

// ProxySemaphoreCount returns the number of per-cluster semaphores
// allocated by the reverse proxy. Used by the /metrics endpoint.
func ProxySemaphoreCount() int {
	proxySemMu.Lock()
	defer proxySemMu.Unlock()
	return len(proxySemBySys)
}

// proxyAcquire returns a release function the caller must call when its
// proxy request returns. Blocks until a slot is free or ctx cancels;
// returns false if ctx fired before a slot opened so the caller can
// 503 rather than continue with an unacquired slot.
func proxyAcquire(ctx context.Context, clusterID string) (release func(), ok bool) {
	proxySemMu.Lock()
	sem, has := proxySemBySys[clusterID]
	if !has {
		sem = make(chan struct{}, proxyConcurrency)
		proxySemBySys[clusterID] = sem
	}
	proxySemMu.Unlock()

	select {
	case sem <- struct{}{}:
		return func() { <-sem }, true
	case <-ctx.Done():
		return nil, false
	}
}

// proxyGrafanaRole is the Grafana role KPilot's embedded session lands
// in. Sent via X-WEBAUTH-ROLE on every request and consumed by Grafana's
// auth.proxy `headers = Role:X-WEBAUTH-ROLE` config.
//
// Admin because the only entry point now is the dedicated
// /clusters/:id/grafana page, positioned as the "do whatever you want
// in Grafana" escape hatch. Curated viewing lives on KPilot's own
// Monitoring / Logging pages, which don't go through this proxy at all.
// Until KPilot grows multi-user, every login is the platform admin and
// expects to author dashboards / datasources / alerts directly.
const proxyGrafanaRole = "Admin"

// hopByHopHeadersServer mirrors the Worker-side list. Keep them in sync —
// each side must strip these on egress so the underlying transport doesn't
// inherit stale connection-control state.
var hopByHopHeadersServer = map[string]struct{}{
	"Connection":          {},
	"Keep-Alive":          {},
	"Proxy-Authenticate":  {},
	"Proxy-Authorization": {},
	"Te":                  {},
	"Trailer":             {},
	"Transfer-Encoding":   {},
	"Upgrade":             {},
}

// wsUpgrader handles the browser → KPilot side of a WebSocket reverse-
// proxy session. CheckOrigin is enforced via the package-shared
// checkWSOrigin: JWT cookie auth alone is NOT enough because SameSite=
// Lax doesn't gate WS handshakes, and a hostile page could otherwise
// open ws:// against the proxy with the user's session cookie
// auto-attached. The origin allow-list is the CORS_ORIGINS env var.
var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4 * 1024,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     checkWSOrigin,
}

// isWSUpgrade returns true when the incoming request asks for an HTTP →
// WebSocket upgrade. Both Connection and Upgrade are case-insensitive in
// HTTP/1.1; Upgrade-Insecure-Requests does NOT count, only "Upgrade".
func isWSUpgrade(req *http.Request) bool {
	if !strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, token := range strings.Split(req.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			return true
		}
	}
	return false
}

// ProxyPlugin reverse-proxies HTTP traffic from the browser through KPilot
// Server, over the gRPC tunnel, into an in-cluster Service exposed by an
// enabled plugin. Bound to /api/v1/clusters/:id/proxy/:plugin/*path.
//
// Handles both the regular HTTP path and the WebSocket upgrade path. WS goes
// through gateway.OpenStream (Pod logs / exec share the same machinery), HTTP
// goes through gateway.SendHTTPRequest.
//
// Auth: the protected route group enforces JWT first; we then know the
// caller is an authenticated KPilot user and inject X-WEBAUTH-USER so
// auth.proxy-aware backends (Grafana) treat the request as a logged-in
// session without ever asking for a password.
func ProxyPlugin(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		pluginName := c.Param("plugin")
		// Don't use c.Param("path") for the upstream URL — gin runs the
		// wildcard value through path-decoding once, so any percent-encoded
		// characters (spaces, '+', non-ASCII, …) are flattened. Re-encoding
		// them is fragile (which chars to escape depends on context).
		// Instead pull EscapedPath() and strip our own route prefix; that
		// preserves the original encoding byte-for-byte.
		prefix := fmt.Sprintf("/api/v1/clusters/%s/proxy/%s", clusterID, pluginName)
		subPath := strings.TrimPrefix(c.Request.URL.EscapedPath(), prefix)
		if subPath == "" {
			subPath = "/"
		}
		// Path-traversal guard: TrimPrefix runs on the escaped path, so
		// a payload like "..%2F..%2Fadmin" survives unchanged. Decode
		// once and reject any ".." segment — upstream services normalize
		// differently (Grafana does, generic Services may not) and we
		// shouldn't rely on the upstream for safety. Strict allow-list
		// (reject ".." substring) keeps the rule simple; any real
		// K8s/Grafana path doesn't contain it.
		if decoded, derr := url.PathUnescape(subPath); derr != nil || strings.Contains(decoded, "..") {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		svc, ok := proxiableServices[pluginName]
		if !ok {
			apiErr(c, http.StatusNotFound, CodePluginNotFound)
			return
		}

		// Cached resolve: validates cluster + plugin row + Phase=Running
		// and returns the release namespace. Cache TTL means a freshly
		// disabled plugin keeps serving up to 30s; we explicitly
		// invalidate from EnablePlugin/DisablePlugin to short-circuit
		// that for the common case.
		releaseNS, code, err := resolvePluginRunning(clusterID, pluginName)
		if err != nil {
			if code != "" {
				status := http.StatusServiceUnavailable
				if code == CodeClusterNotFound || code == CodePluginNotFound {
					status = http.StatusNotFound
				}
				apiErr(c, status, code)
				return
			}
			apiErrInternal(c, err)
			return
		}

		// Branch: WS upgrade has its own pump-driven path (no body, no
		// timeout, bidirectional). Everything else flows through the
		// HTTP request-response path.
		if isWSUpgrade(c.Request) {
			username := resolveUsername(c)
			proxyWebSocket(c, gw, clusterID, svc, releaseNS, subPath, username)
			return
		}

		// Read at most proxyMaxBodyBytes of the request body. Browser
		// uploads to Grafana (e.g. importing a dashboard JSON) are
		// kilobytes, so the cap is a safety net rather than a real
		// constraint.
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, proxyMaxBodyBytes))
		if err != nil {
			apiErr(c, http.StatusRequestEntityTooLarge, CodeInvalidRequest)
			return
		}

		// Compose the upstream URL the Worker will dial. RawQuery passes
		// through unchanged so e.g. ?orgId=1&from=now-1h... reaches Grafana
		// untouched. Path always starts with "/" (see subPath default).
		// Use the fully-qualified ".svc.<cluster-domain>" form rather than
		// the short ".svc" — DNS search-path resolution of the short form
		// works on most clusters but fails on custom resolv.conf, custom
		// cluster domain, dnsPolicy=None, or sidecar DNS interception. The
		// FQDN sidesteps all of that. cluster_domain comes from the Worker
		// (it's the only side that knows what its own kubelet's
		// --cluster-domain is); falls back to the CoreDNS default.
		query := c.Request.URL.RawQuery
		target := fmt.Sprintf("http://%s.%s.svc.%s:%d%s",
			svc.Service, releaseNS, workerClusterDomain(gw, clusterID), svc.Port, subPath)
		if query != "" {
			target += "?" + query
		}

		headers := make([]*proto.HTTPHeader, 0, len(c.Request.Header)+1)
		for name, values := range c.Request.Header {
			if _, hop := hopByHopHeadersServer[name]; hop {
				continue
			}
			canon := http.CanonicalHeaderKey(name)
			// Authorization carries KPilot's session via Bearer token in
			// some clients — drop it; the proxied request authenticates
			// to upstream via X-WEBAUTH-USER below.
			if canon == "Authorization" {
				continue
			}
			// Cookie deserves surgery rather than a wholesale strip:
			// Grafana stores its own session cookie under KPilot's
			// domain (because that's the URL the browser sees), and we
			// MUST forward it on subsequent requests or every page load
			// looks like a fresh session and CSRF / org-context breaks.
			// Filter only the cookies KPilot itself owns.
			if canon == "Cookie" {
				for _, v := range values {
					if filtered := filterKPilotCookies(v); filtered != "" {
						headers = append(headers, &proto.HTTPHeader{Name: name, Value: filtered})
					}
				}
				continue
			}
			// Drop incoming X-WEBAUTH-USER / X-WEBAUTH-ROLE — never trust
			// client-supplied values for headers we use to authorize the
			// upstream.
			if canon == "X-Webauth-User" || canon == "X-Webauth-Role" {
				continue
			}
			for _, v := range values {
				headers = append(headers, &proto.HTTPHeader{Name: name, Value: v})
			}
		}
		// Inject the auth.proxy headers. Username comes from the JWT
		// middleware (single-tenant "admin" today). Role is hardcoded
		// to keep the embed read-only; auth.proxy's `headers` config
		// applies it on every request, so even old Admin accounts get
		// downgraded immediately.
		headers = append(headers, &proto.HTTPHeader{Name: "X-WEBAUTH-USER", Value: resolveUsername(c)})
		headers = append(headers, &proto.HTTPHeader{Name: "X-WEBAUTH-ROLE", Value: proxyGrafanaRole})

		req := &proto.HTTPRequest{
			Method:  c.Request.Method,
			Url:     target,
			Headers: headers,
			Body:    body,
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), proxyTimeout)
		defer cancel()

		// Bound in-flight proxy requests per cluster — Grafana dashboard
		// loads fan out to 30+ parallel asset fetches; the cap stops one
		// user from saturating the worker's HTTP transport. Acquire
		// fails fast on ctx cancel so the browser sees a clean 503
		// instead of waiting the full proxyTimeout.
		release, ok := proxyAcquire(ctx, clusterID)
		if !ok {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		defer release()

		resp, err := gw.SendHTTPRequest(ctx, clusterID, req)
		if err != nil {
			log.Printf("[proxy] gateway send failed: cluster=%s plugin=%s err=%v",
				clusterID, pluginName, err)
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		if resp.Error != "" {
			// Worker couldn't reach the Service (DNS, connect, timeout) —
			// surface as 502 with the upstream error so the embedded UI
			// doesn't show a blank screen. apiErrDetail keeps the JSON
			// envelope consistent with the rest of the API so the
			// frontend's requestErrorConfig pipeline can translate
			// `code: PROXY_UPSTREAM_ERROR` to a localized toast.
			log.Printf("[proxy] worker dispatch failed: cluster=%s plugin=%s err=%s",
				clusterID, pluginName, resp.Error)
			apiErrDetail(c, http.StatusBadGateway, CodeProxyUpstream, resp.Error)
			return
		}

		// Replay headers back to the browser, dropping hop-by-hop ones
		// (already filtered worker-side, defense-in-depth here).
		for _, h := range resp.Headers {
			canon := http.CanonicalHeaderKey(h.Name)
			if _, hop := hopByHopHeadersServer[canon]; hop {
				continue
			}
			// Content-Length is recomputed by Gin from the body we write.
			if canon == "Content-Length" {
				continue
			}
			// gorilla/websocket-style Sec-* headers belong to the WS
			// upgrade path that's wired up in Step C; for the plain HTTP
			// path here, drop any stray ones.
			if strings.HasPrefix(canon, "Sec-Websocket-") {
				continue
			}
			c.Writer.Header().Add(h.Name, h.Value)
		}
		c.Writer.WriteHeader(int(resp.Status))
		_, _ = c.Writer.Write(resp.Body)
	}
}

// resolveUsername pulls the authenticated user from the gin context (set by
// the JWT middleware). Falls back to "admin" since we're single-tenant; this
// keeps the proxy from sending an empty X-WEBAUTH-USER if someone bypasses
// the middleware in dev.
func resolveUsername(c *gin.Context) string {
	if u, ok := c.Get("username"); ok {
		if s, ok := u.(string); ok && s != "" {
			return s
		}
	}
	return "admin"
}

// proxyWebSocket runs the bidirectional WS pump for a single browser → KPilot
// → gRPC tunnel → upstream WebSocket session. Returns when either side closes
// or the gRPC stream goes away.
func proxyWebSocket(
	c *gin.Context,
	gw *gateway.GatewayServer,
	clusterID string,
	svc proxiableService,
	releaseNS, subPath, username string,
) {
	// Open the gRPC stream first — if the worker is gone we shouldn't even
	// upgrade the browser conn, just return a clean 503.
	stream, err := gw.OpenStream(clusterID)
	if err != nil {
		apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
		return
	}

	// Strip Connection / Upgrade / Sec-WebSocket-* before handing the
	// remaining headers to the worker — gorilla/websocket sets them itself
	// on the dial side. Same Cookie / X-WEBAUTH-USER rules as the HTTP path.
	wsHeaders := make([]*proto.HTTPHeader, 0, len(c.Request.Header)+1)
	for name, values := range c.Request.Header {
		canon := http.CanonicalHeaderKey(name)
		if _, hop := hopByHopHeadersServer[canon]; hop {
			continue
		}
		if strings.HasPrefix(canon, "Sec-Websocket-") {
			continue
		}
		if canon == "Authorization" || canon == "X-Webauth-User" || canon == "X-Webauth-Role" {
			continue
		}
		if canon == "Cookie" {
			for _, v := range values {
				if filtered := filterKPilotCookies(v); filtered != "" {
					wsHeaders = append(wsHeaders, &proto.HTTPHeader{Name: name, Value: filtered})
				}
			}
			continue
		}
		for _, v := range values {
			wsHeaders = append(wsHeaders, &proto.HTTPHeader{Name: name, Value: v})
		}
	}
	wsHeaders = append(wsHeaders, &proto.HTTPHeader{Name: "X-WEBAUTH-USER", Value: username})
	wsHeaders = append(wsHeaders, &proto.HTTPHeader{Name: "X-WEBAUTH-ROLE", Value: proxyGrafanaRole})

	query := c.Request.URL.RawQuery
	target := fmt.Sprintf("ws://%s.%s.svc.%s:%d%s",
		svc.Service, releaseNS, workerClusterDomain(gw, clusterID), svc.Port, subPath)
	if query != "" {
		target += "?" + query
	}

	// Note on ordering: we Send WSStartRequest first, then Upgrade the
	// browser conn. There's a tiny window where the worker's upstream
	// dial completes and starts pushing WSFrame back through the Stream
	// before the browser pump goroutine is reading. Stream's msgCh is
	// buffered (256 frames) and Stream.deliver drops on full, so brief
	// catch-up is fine; Grafana's WS handshake doesn't push pre-handshake
	// frames anyway. Reversing the order would mean we'd promote the
	// browser conn before knowing the worker accepted the request — worse
	// failure mode (already-upgraded conn with no upstream).
	if err := stream.Send(&proto.WSStartRequest{Url: target, Headers: wsHeaders}); err != nil {
		stream.Close()
		apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
		return
	}

	// Upgrade the browser conn AFTER WSStartRequest is on the wire, so we
	// don't promote a connection that the worker can't service.
	rawConn, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// Upgrade writes its own response on failure; tell the worker to
		// abandon the upstream dial.
		_ = stream.SendWSEnd(&proto.WSEnd{Reason: "browser upgrade failed"})
		stream.Close()
		return
	}
	defer rawConn.Close()

	// Wrap in wsConn so the WriteMessage / WriteControl calls below are
	// serialised under the per-conn mutex (matches PodLogs / PodExec /
	// PluginInstallLog). The reverse-proxy pumps below are single-writer
	// today, but the wrapper closes off a foot-gun for any future change
	// that adds a second writer, and gets us startHeartbeat for free.
	browserConn := newWSConn(rawConn)
	hbCtx, hbCancel := context.WithCancel(c.Request.Context())
	defer hbCancel()
	browserConn.startHeartbeat(hbCtx)

	// Browser → upstream pump.
	go func() {
		for {
			opcode, data, err := rawConn.ReadMessage()
			if err != nil {
				var ce *websocket.CloseError
				if errors.As(err, &ce) {
					_ = stream.SendWSEnd(&proto.WSEnd{Code: int32(ce.Code), Reason: ce.Text})
				} else {
					_ = stream.SendWSEnd(&proto.WSEnd{Reason: err.Error()})
				}
				stream.Close()
				return
			}
			if err := stream.SendWSFrame(&proto.WSFrame{Opcode: int32(opcode), Data: data}); err != nil {
				stream.Close()
				return
			}
		}
	}()

	// Upstream → browser pump (main loop). Exits when the stream closes
	// (worker disconnect, end frame, or browser-side closer above).
	for msg := range stream.Recv() {
		switch p := msg.Payload.(type) {
		case *proto.WorkerMessage_WsFrameRecv:
			frame := p.WsFrameRecv
			op := int(frame.Opcode)
			if op == 0 {
				op = websocket.TextMessage
			}
			if err := browserConn.WriteMessage(op, frame.Data); err != nil {
				stream.Close()
				return
			}
		case *proto.WorkerMessage_WsEndRecv:
			end := p.WsEndRecv
			code := int(end.Code)
			if code == 0 {
				code = websocket.CloseAbnormalClosure
			}
			_ = browserConn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(code, end.Reason),
				time.Now().Add(writeWait),
			)
			stream.Close()
			return
		}
	}
	// Channel closed without an explicit end frame — worker disconnect or
	// the gateway's stream cleanup. Send the browser a polite close so it
	// doesn't see an abnormal-close (1006) and silently retry forever; a
	// 1001 Going Away triggers most clients' standard reconnect-with-
	// backoff path instead.
	_ = browserConn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseGoingAway, "upstream connection lost"),
		time.Now().Add(writeWait),
	)
}

// kpilotCookieNames are the Set-Cookie names KPilot Server itself owns. We
// MUST strip these when proxying to upstream — leaking the JWT to Grafana
// is a session-stealing primitive — but everything else (Grafana session
// cookies set via response Set-Cookie, stored under KPilot's domain because
// that's what the browser sees) MUST pass through or upstream session /
// CSRF state breaks on every other request.
var kpilotCookieNames = map[string]struct{}{
	"kpilot_token": {},
}

// filterKPilotCookies takes a raw Cookie header value (k1=v1; k2=v2; ...)
// and returns the same value with KPilot-owned cookies removed. Returns
// the empty string if the entire header would be empty after filtering, so
// the caller can drop the header altogether instead of sending "Cookie: ".
func filterKPilotCookies(raw string) string {
	parts := strings.Split(raw, ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			continue
		}
		// Cookie format is name=value; treat anything before "=" as name.
		eq := strings.IndexByte(trimmed, '=')
		name := trimmed
		if eq >= 0 {
			name = trimmed[:eq]
		}
		if _, drop := kpilotCookieNames[name]; drop {
			continue
		}
		out = append(out, trimmed)
	}
	return strings.Join(out, "; ")
}
