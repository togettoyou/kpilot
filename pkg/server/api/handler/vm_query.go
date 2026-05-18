// Package handler — shared VictoriaMetrics query primitives.
//
// Three /compute pages talk to VM through the worker tunnel
// (device-health, gpu-hour, gpu-metrics). All three need the same
// plumbing: locate the in-cluster VM Service via the plugin registry,
// urlQueryEscape PromQL strings without mangling operator characters,
// fire `/api/v1/query` (instant) or `/api/v1/query_range` (series),
// parse the result envelope.
//
// Each call goes through gw.SendHTTPRequest so VM stays a server-side
// implementation detail — the browser only ever talks to /api/v1/*
// KPilot endpoints, no proxied VM surface.
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// vmTimeout caps a single PromQL request through the gateway. Queries
// against the bundled victoria-metrics-single chart return in tens of
// milliseconds on healthy clusters; 60s leaves headroom for legitimate
// long-range queries (1h step over a busy cluster's full retention)
// without holding the browser indefinitely. Chunked transport means
// large response bodies no longer threaten Heartbeat liveness, so the
// budget can be generous.
const vmTimeout = 60 * time.Second

// resolveVMQueryURL returns the base URL of the cluster's VictoriaMetrics
// /api/v1 endpoint, going through resolvePluginRunning (shared with the
// reverse proxy, with a 30s TTL cache so the GPU pages don't re-issue
// three DB queries per fan-out tick). The VM Service name follows the
// chart convention "<release>-victoria-metrics-single-server" — the
// chart we ship pins the release name to the kpilot plugin name
// "victoria-metrics", so the FQDN is
// "victoria-metrics-victoria-metrics-single-server.<ns>.svc.<dom>".
func resolveVMQueryURL(gw *gateway.GatewayServer, clusterID string) (string, string, error) {
	releaseNS, code, err := resolvePluginRunning(clusterID, "victoria-metrics")
	if err != nil {
		return "", code, err
	}
	dom := workerClusterDomain(gw, clusterID)
	host := fmt.Sprintf("victoria-metrics-victoria-metrics-single-server.%s.svc.%s",
		releaseNS, dom)
	return fmt.Sprintf("http://%s:8428", host), "", nil
}

// vmSeries is one instant-vector sample.
type vmSeries struct {
	Labels map[string]string
	Value  float64
}

// vmRangeSeries is one matrix-result row: a (labels) → ordered list of
// (timestamp, value) points.
type vmRangeSeries struct {
	Labels map[string]string
	Points []vmRangePoint
}

type vmRangePoint struct {
	// Timestamp in unix milliseconds — what JSON time charts on the
	// frontend want directly. (VM emits seconds-with-fraction; we
	// multiply at parse time so frontends don't have to.)
	Ts    int64
	Value float64
}

// queryVM runs a single PromQL `query` (instant — no range) against the
// VM HTTP API and parses the standard `{status, data:{resultType, result:[]}}`
// envelope. Returns the parsed series; non-vector result types raise.
func queryVM(ctx context.Context, gw *gateway.GatewayServer, clusterID, baseURL, promql string) ([]vmSeries, error) {
	q := fmt.Sprintf("%s/api/v1/query?query=%s", baseURL, urlQueryEscape(promql))
	resp, err := gw.SendHTTPRequest(ctx, clusterID, &gateway.HTTPRequest{
		Method: http.MethodGet,
		URL:    q,
	})
	if err != nil {
		return nil, fmt.Errorf("send VM query: %w", err)
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("worker VM dispatch: %s", resp.Error)
	}
	if int(resp.Status) != http.StatusOK {
		body := string(resp.Body)
		if len(body) > 200 {
			body = body[:200] + "…"
		}
		return nil, fmt.Errorf("VM HTTP %d: %s", resp.Status, body)
	}
	var env struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Metric map[string]string `json:"metric"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Body, &env); err != nil {
		return nil, fmt.Errorf("parse VM response: %w", err)
	}
	if env.Status != "success" {
		return nil, fmt.Errorf("VM status=%s", env.Status)
	}
	if env.Data.ResultType != "vector" {
		return nil, fmt.Errorf("expected vector result, got %s", env.Data.ResultType)
	}
	out := make([]vmSeries, 0, len(env.Data.Result))
	for _, r := range env.Data.Result {
		v := 0.0
		if len(r.Value) == 2 {
			if s, ok := r.Value[1].(string); ok {
				if parsed, perr := strconv.ParseFloat(s, 64); perr == nil {
					v = parsed
				}
			}
		}
		out = append(out, vmSeries{Labels: r.Metric, Value: v})
	}
	return out, nil
}

// queryVMRange runs a PromQL query over the [from, to] window with the
// given step. Matrix result rows are returned as ordered point lists so
// the frontend can render line charts directly. Timestamps come back
// in unix milliseconds.
func queryVMRange(ctx context.Context, gw *gateway.GatewayServer, clusterID, baseURL, promql string, from, to time.Time, step time.Duration) ([]vmRangeSeries, error) {
	q := fmt.Sprintf("%s/api/v1/query_range?query=%s&start=%d&end=%d&step=%d",
		baseURL,
		urlQueryEscape(promql),
		from.Unix(), to.Unix(), int(step.Seconds()),
	)
	resp, err := gw.SendHTTPRequest(ctx, clusterID, &gateway.HTTPRequest{
		Method: http.MethodGet,
		URL:    q,
	})
	if err != nil {
		return nil, fmt.Errorf("send VM range query: %w", err)
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("worker VM dispatch: %s", resp.Error)
	}
	if int(resp.Status) != http.StatusOK {
		body := string(resp.Body)
		if len(body) > 200 {
			body = body[:200] + "…"
		}
		return nil, fmt.Errorf("VM HTTP %d: %s", resp.Status, body)
	}
	var env struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Metric map[string]string `json:"metric"`
				// Each "value" pair is [<unix-seconds-float>, "<value>"];
				// the value is a string to preserve float precision.
				Values [][2]any `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Body, &env); err != nil {
		return nil, fmt.Errorf("parse VM range response: %w", err)
	}
	if env.Status != "success" {
		return nil, fmt.Errorf("VM status=%s", env.Status)
	}
	if env.Data.ResultType != "matrix" {
		return nil, fmt.Errorf("expected matrix result, got %s", env.Data.ResultType)
	}
	out := make([]vmRangeSeries, 0, len(env.Data.Result))
	for _, r := range env.Data.Result {
		points := make([]vmRangePoint, 0, len(r.Values))
		for _, pt := range r.Values {
			if len(pt) != 2 {
				continue
			}
			// Timestamp comes through as float64 from json.Unmarshal —
			// json.Number is off by default and these are seconds with
			// optional fractional millis. Multiply to ms for chart APIs.
			tsF, ok := pt[0].(float64)
			if !ok {
				continue
			}
			vstr, ok := pt[1].(string)
			if !ok {
				continue
			}
			v, perr := strconv.ParseFloat(vstr, 64)
			if perr != nil {
				continue
			}
			points = append(points, vmRangePoint{
				Ts:    int64(tsF * 1000),
				Value: v,
			})
		}
		out = append(out, vmRangeSeries{Labels: r.Metric, Points: points})
	}
	return out, nil
}

// urlQueryEscape is a minimal RFC 3986 query-string encoder. We can't
// use net/url because it would escape "{" / "}" / "(" which VM accepts
// in its query strings, and the encoded result wouldn't round-trip
// through worker proxying.
//
// Whitelisted (passed through unescaped): alnum, `_-.~/:[](){},!<>=*|"`.
// The PromQL grammar uses `=` inside label matchers (`{label="value"}`);
// the URL parser still works because only the first `=` in `?query=…`
// is treated as the key/value separator.
//
// Escaped (anything else hits the percent-escape default branch):
// `&` — would split query params on the upstream side.
// `+` — URL parsing decodes `+` → space, so a literal `+` would silently
//   become a space; encoded as `%2B` to keep the byte.
// `%` `#` `?` `\` `^` — generally unsafe in query values.
// Space — encoded as the legacy `+` form (one-byte shorter than `%20`)
//   since VM's parser accepts both interchangeably.
func urlQueryEscape(s string) string {
	const hex = "0123456789ABCDEF"
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9',
			c >= 'A' && c <= 'Z',
			c >= 'a' && c <= 'z',
			c == '_', c == '-', c == '.', c == '~', c == '/',
			c == ':', c == '[', c == ']', c == '(', c == ')',
			c == '{', c == '}', c == ',', c == '!', c == '<', c == '>',
			c == '=', c == '*', c == '|', c == '"':
			out = append(out, c)
		case c == ' ':
			out = append(out, '+')
		default:
			out = append(out, '%', hex[c>>4], hex[c&0xF])
		}
	}
	return string(out)
}
