package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
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

// ProxyPlugin reverse-proxies HTTP traffic from the browser through KPilot
// Server, over the gRPC tunnel, into an in-cluster Service exposed by an
// enabled plugin. Bound to /api/v1/clusters/:id/proxy/:plugin/*path.
//
// Auth: the protected route group enforces JWT first; we then know the
// caller is an authenticated KPilot user and inject X-WEBAUTH-USER so
// auth.proxy-aware backends (Grafana) treat the request as a logged-in
// session without ever asking for a password.
func ProxyPlugin(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		pluginName := c.Param("plugin")
		// Gin's `*path` puts the wildcard match into `path` param; it
		// always begins with "/". Treat empty as "/" (some clients hit
		// /proxy/grafana with no trailing slash).
		subPath := c.Param("path")
		if subPath == "" {
			subPath = "/"
		}

		svc, ok := proxiableServices[pluginName]
		if !ok {
			apiErr(c, http.StatusNotFound, CodePluginNotFound)
			return
		}

		// Check the cluster + plugin row exists and is Running. Other
		// phases (Pending/Failed/Uninstalling) wouldn't have a working
		// Service to proxy to; surfacing 503 is friendlier than letting
		// the Worker time out.
		if _, err := store.GetClusterByID(clusterID); err != nil {
			apiErr(c, http.StatusNotFound, CodeClusterNotFound)
			return
		}
		plugin, err := store.GetPluginByName(pluginName)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				apiErr(c, http.StatusNotFound, CodePluginNotFound)
				return
			}
			apiErrInternal(c, err)
			return
		}
		cp, err := store.GetClusterPlugin(clusterID, plugin.ID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				apiErr(c, http.StatusServiceUnavailable, CodePluginNotEnabled)
				return
			}
			apiErrInternal(c, err)
			return
		}
		if !cp.Enabled || cp.Phase != store.PluginPhaseRunning {
			apiErr(c, http.StatusServiceUnavailable, CodePluginNotRunning)
			return
		}

		releaseNS := cp.ReleaseNamespaceOverride
		if releaseNS == "" {
			releaseNS = plugin.DefaultReleaseNamespace
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
		username := "admin"
		if u, ok := c.Get("username"); ok {
			if s, ok := u.(string); ok && s != "" {
				username = s
			}
		}
		headers = append(headers, &proto.HTTPHeader{Name: "X-WEBAUTH-USER", Value: username})

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
