// Package gateway — public types handlers consume.
//
// In v1 these lived in chunked.go alongside the chunked transport
// helpers; phase B consolidates the type definitions here so the
// v2 yamux rewrite of the send code paths reads cleanly without
// the legacy framing helpers in the same file.
//
// HTTPHeader is still pinned to the v1 proto type during the
// migration window so handlers don't have to switch imports.
// The v2 proto's HTTPHeader is structurally identical (Name,
// Value) and gateway code converts at the wire boundary.
package gateway

import "github.com/togettoyou/kpilot/pkg/common/proto"

// HTTPRequest is the high-level shape handlers pass to
// SendHTTPRequest / SendHTTPRequestStream.
type HTTPRequest struct {
	Method  string
	URL     string
	Headers []*proto.HTTPHeader
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
	Headers []*proto.HTTPHeader
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
