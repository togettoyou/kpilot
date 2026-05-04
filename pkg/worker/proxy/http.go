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
	"time"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

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
}

// NewHTTPProxy builds an HTTPProxy with sensible defaults for the in-cluster
// service traffic this layer carries (a Grafana dashboard load can pull a few
// MB of JSON; static asset fetches are tiny). The send function should be the
// tunnel client's SendHTTPResponse.
func NewHTTPProxy(sendFn func(string, *proto.HTTPResponse)) *HTTPProxy {
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
		sendFn: sendFn,
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

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

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

	respBody, err := io.ReadAll(hresp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
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
