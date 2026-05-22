// Package proxy — internal request shapes the worker proxy code
// passes around. In v1 these lived in pkg/worker/tunnel and were
// re-exported across the worker; phase C drops the transport
// dependency on those shapes and keeps an internal local copy
// here so the rest of the proxy package (http.go's 800 lines,
// dispatch helpers, in-cluster routing) doesn't have to switch
// to pbv2 wire types just because the transport changed.
//
// The stream entry points (HandleStream / HandleHTTPStream / etc.)
// translate from pbv2.* on the wire into these local shapes at the
// boundary and let the rest of the package proceed unchanged.
package proxy

import "github.com/togettoyou/kpilot/pkg/common/proto"

// HTTPRequest is the proxy-internal HTTP forward request shape.
// Mirrors the old tunnel.HTTPRequest — same field set; the
// rename to "proxy.HTTPRequest" just decouples this from the
// transport package.
//
// Headers keeps the v1 proto.HTTPHeader type for now — http.go
// references it pervasively (response header forwarding,
// gateway-side conversion) and the v1 proto pkg still exists.
// Phase D may swap to a local type to fully drop v1 proto from
// the worker side.
type HTTPRequest struct {
	Method  string
	URL     string
	Headers []*proto.HTTPHeader
	Body    []byte
	// StreamResponse asks the worker to forward upstream body
	// bytes live (per-token SSE for inference) rather than
	// buffering the whole response.
	StreamResponse bool
}

// ResourceRequest is the proxy-internal K8s resource RPC shape.
type ResourceRequest struct {
	Action        string
	Group         string
	Version       string
	Kind          string
	Namespace     string
	Name          string
	Body          []byte
	Limit         int64
	ContinueToken string
	LabelSelector string
}

// PluginCommand / PluginSpec / ChartSource live in
// pkg/worker/tunnel because pkg/worker/plugin imports tunnel
// (not proxy) and we don't want to add a new import cycle. The
// stream handler in cmd/worker/main.go decodes pbv2 into
// tunnel.PluginCommand and calls plugin.Manager.Handle.
