// Package gateway — public types handlers consume.
//
// HTTPHeader uses the v2 pbv2.HTTPHeader type directly (Name,
// Value); v1 proto is retired in phase D so there's no separate
// wire conversion any more.
package gateway

import pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"

// HTTPRequest is the high-level shape handlers pass to
// SendHTTPRequest / SendHTTPRequestStream.
type HTTPRequest struct {
	Method  string
	URL     string
	Headers []*pbv2.HTTPHeader
	Body    []byte
	// StreamResponse asks the worker to forward upstream body bytes
	// live (per-token SSE for inference). Ignored by SendHTTPRequest
	// (always buffered); set by SendHTTPRequestStream automatically.
	StreamResponse bool
}

// HTTPResponse is the assembled reverse-proxy response delivered
// to SendHTTPRequest callers. Body is nil/empty on 204 / dispatch
// error.
type HTTPResponse struct {
	Status  int32
	Headers []*pbv2.HTTPHeader
	Body    []byte
	Error   string
}

// ResourceRequest is the high-level shape handlers pass to
// SendResourceRequest.
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

// ResourceResponse is the assembled K8s proxy response delivered
// to SendResourceRequest callers.
type ResourceResponse struct {
	Success bool
	Error   string
	Data    []byte
}
