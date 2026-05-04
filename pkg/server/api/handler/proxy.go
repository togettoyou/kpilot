package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"gorm.io/gorm"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
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

// proxyResolveTTL is how long a (cluster, plugin) → namespace lookup is
// reused without hitting the DB. A Grafana dashboard load fans out to 30+
// parallel requests for assets — without caching, each one repeats the
// same three queries (cluster + plugin + cluster_plugin row). 30s is
// short enough that disabling a plugin in one tab kicks in within a
// dashboard refresh in another.
const proxyResolveTTL = 30 * time.Second

// proxyResolveEntry is the cached result of validating that a plugin is
// installed and Running on a cluster. cachedAt is checked on every
// lookup; on miss we re-query the DB.
type proxyResolveEntry struct {
	releaseNS string
	cachedAt  time.Time
}

var (
	proxyResolveMu    sync.RWMutex
	proxyResolveCache = make(map[string]proxyResolveEntry)
)

// resolveProxyTarget validates the cluster + plugin combo and returns the
// release namespace, hitting the cache on the hot path. Errors are gin
// codes ready to pass to apiErr; success returns ("", nil). On non-cached
// paths we still re-validate Phase=Running so a freshly disabled plugin
// stops accepting traffic within proxyResolveTTL.
func resolveProxyTarget(clusterID, pluginName string) (releaseNS string, code string, err error) {
	key := clusterID + "/" + pluginName

	proxyResolveMu.RLock()
	entry, ok := proxyResolveCache[key]
	proxyResolveMu.RUnlock()
	if ok && time.Since(entry.cachedAt) < proxyResolveTTL {
		return entry.releaseNS, "", nil
	}

	if _, err := store.GetClusterByID(clusterID); err != nil {
		return "", CodeClusterNotFound, err
	}
	plugin, err := store.GetPluginByName(pluginName)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", CodePluginNotFound, err
		}
		return "", "", err
	}
	cp, err := store.GetClusterPlugin(clusterID, plugin.ID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", CodePluginNotEnabled, err
		}
		return "", "", err
	}
	if !cp.Enabled || cp.Phase != store.PluginPhaseRunning {
		return "", CodePluginNotRunning, fmt.Errorf("plugin not running")
	}

	releaseNS = cp.ReleaseNamespaceOverride
	if releaseNS == "" {
		releaseNS = plugin.DefaultReleaseNamespace
	}
	proxyResolveMu.Lock()
	proxyResolveCache[key] = proxyResolveEntry{
		releaseNS: releaseNS,
		cachedAt:  time.Now(),
	}
	proxyResolveMu.Unlock()
	return releaseNS, "", nil
}

// InvalidateProxyResolve drops cached lookups for a (cluster, plugin) so
// the next proxy request re-checks DB state. Called by the plugin enable/
// disable handlers when state changes that would affect routing.
func InvalidateProxyResolve(clusterID, pluginName string) {
	key := clusterID + "/" + pluginName
	proxyResolveMu.Lock()
	delete(proxyResolveCache, key)
	proxyResolveMu.Unlock()
}

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

// wsUpgrader handles the browser → KPilot side of a WebSocket reverse-proxy
// session. CheckOrigin returns true unconditionally because the request has
// already been authenticated by the JWT middleware — we accept all origins
// the browser would have set since the proxy is same-origin from KPilot's
// perspective anyway.
var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4 * 1024,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
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
		releaseNS, code, err := resolveProxyTarget(clusterID, pluginName)
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
		query := c.Request.URL.RawQuery
		target := fmt.Sprintf("http://%s.%s.svc:%d%s",
			svc.Service, releaseNS, svc.Port, subPath)
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
			// Drop incoming X-WEBAUTH-USER — never trust client-supplied
			// values for headers we use to authorize the upstream.
			if canon == "X-Webauth-User" {
				continue
			}
			for _, v := range values {
				headers = append(headers, &proto.HTTPHeader{Name: name, Value: v})
			}
		}
		// Inject the auth.proxy header. The username comes from the JWT
		// middleware ctx — currently always "admin" since we're single-
		// tenant, but we read it from context anyway so multi-user just
		// works when we add it.
		headers = append(headers, &proto.HTTPHeader{Name: "X-WEBAUTH-USER", Value: resolveUsername(c)})

		req := &proto.HTTPRequest{
			Method:  c.Request.Method,
			Url:     target,
			Headers: headers,
			Body:    body,
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), proxyTimeout)
		defer cancel()
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
			// doesn't show a blank screen.
			log.Printf("[proxy] worker dispatch failed: cluster=%s plugin=%s err=%s",
				clusterID, pluginName, resp.Error)
			c.String(http.StatusBadGateway, "proxy upstream error: %s", resp.Error)
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
		if canon == "Authorization" || canon == "X-Webauth-User" {
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

	query := c.Request.URL.RawQuery
	target := fmt.Sprintf("ws://%s.%s.svc:%d%s",
		svc.Service, releaseNS, svc.Port, subPath)
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
	browserConn, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// Upgrade writes its own response on failure; tell the worker to
		// abandon the upstream dial.
		_ = stream.SendWSEnd(&proto.WSEnd{Reason: "browser upgrade failed"})
		stream.Close()
		return
	}
	defer browserConn.Close()

	// Browser → upstream pump.
	go func() {
		for {
			opcode, data, err := browserConn.ReadMessage()
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
			_ = browserConn.SetWriteDeadline(time.Now().Add(writeWait))
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
