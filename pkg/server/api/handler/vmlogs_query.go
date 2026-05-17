// Package handler — shared VictoriaLogs query primitives.
//
// Mirrors vm_query.go but for VictoriaLogs (LogsQL). The Logging page
// hits two endpoints through the worker tunnel:
//
//   /select/logsql/query           — return matching log lines
//   /select/logsql/stats_query_range — bucketed counts over time
//
// VictoriaLogs has a Vector DaemonSet built into the chart we ship
// (`vector.enabled=true` in the victoria-logs plugin defaults), so a
// freshly enabled plugin produces data within a minute — no separate
// log collector to wire.
package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// vmlogsTimeout caps a single LogsQL request. VL responses can be large
// when the user searches broad time ranges; the per-request handler
// guards size separately. 30s lets a 24h scan of a busy cluster
// finish without holding the browser indefinitely.
const vmlogsTimeout = 30 * time.Second

// resolveVMLogsURL returns the base URL of the cluster's VictoriaLogs
// HTTP API. The chart we ship pins the release name to the kpilot
// plugin name "victoria-logs"; the Service is then
// "victoria-logs-victoria-logs-single-server.<ns>.svc.<dom>:9428".
// Plugin-resolve cache (30s TTL) is shared with VM + the reverse proxy.
func resolveVMLogsURL(gw *gateway.GatewayServer, clusterID string) (string, string, error) {
	releaseNS, code, err := resolvePluginRunning(clusterID, "victoria-logs")
	if err != nil {
		return "", code, err
	}
	dom := workerClusterDomain(gw, clusterID)
	host := fmt.Sprintf("victoria-logs-victoria-logs-single-server.%s.svc.%s",
		releaseNS, dom)
	return fmt.Sprintf("http://%s:9428", host), "", nil
}

// vmLogLine is one decoded log entry, projected to the fields the
// Logging page renders. Everything else from the original record lives
// in `Fields` so the frontend can show structured key/value when the
// user expands a row without us having to enumerate every Vector
// attribute on the wire.
type vmLogLine struct {
	Time      time.Time         `json:"time"`
	Message   string            `json:"message"`
	Stream    string            `json:"stream,omitempty"`
	Namespace string            `json:"namespace,omitempty"`
	Pod       string            `json:"pod,omitempty"`
	Container string            `json:"container,omitempty"`
	Node      string            `json:"node,omitempty"`
	Fields    map[string]string `json:"fields,omitempty"`
}

// queryVMLogs runs a LogsQL `query` over [from, to], returning at most
// `limit` lines. VL streams its response as one NDJSON object per line
// — we decode them all in one shot because the limit caps memory.
func queryVMLogs(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID, baseURL, query string,
	from, to time.Time,
	limit int,
) ([]vmLogLine, error) {
	if limit <= 0 {
		limit = 200
	}
	// VL parses bare integers as seconds-since-epoch (suffix "ns"/"us"/
	// "ms" needed for sub-second resolution). UnixNano() without a
	// suffix sends a number ~10^9 too large — VL would interpret it as
	// far-future seconds and return zero matches. queryVMLogsHistogram
	// uses Unix() correctly; align here.
	u := fmt.Sprintf("%s/select/logsql/query?query=%s&start=%d&end=%d&limit=%d",
		baseURL,
		urlQueryEscape(query),
		from.Unix(), to.Unix(),
		limit,
	)
	resp, err := gw.SendHTTPRequest(ctx, clusterID, &proto.HTTPRequest{
		Method: http.MethodGet,
		Url:    u,
	})
	if err != nil {
		return nil, fmt.Errorf("send VL query: %w", err)
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("worker VL dispatch: %s", resp.Error)
	}
	if int(resp.Status) != http.StatusOK {
		body := string(resp.Body)
		if len(body) > 200 {
			body = body[:200] + "…"
		}
		return nil, fmt.Errorf("VL HTTP %d: %s", resp.Status, body)
	}
	out := make([]vmLogLine, 0, limit)
	scanner := bufio.NewScanner(bytes.NewReader(resp.Body))
	// Single log lines can be quite long (stack traces, JSON payloads);
	// raise the bufio scanner limit so we don't truncate.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		raw := scanner.Bytes()
		if len(raw) == 0 {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		out = append(out, projectLogLine(rec))
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

// projectLogLine pulls the well-known fields Vector emits for K8s pod
// logs and stuffs the rest under Fields. The exact key names match
// Vector's default "kubernetes_logs" source schema (the chart we ship
// uses that source unchanged).
func projectLogLine(rec map[string]any) vmLogLine {
	ln := vmLogLine{Fields: map[string]string{}}
	for k, v := range rec {
		sv, _ := v.(string)
		switch k {
		case "_time":
			if t, err := time.Parse(time.RFC3339Nano, sv); err == nil {
				ln.Time = t
			}
		case "_msg", "message":
			ln.Message = sv
		case "stream":
			ln.Stream = sv
		case "kubernetes.pod_namespace", "kubernetes_namespace_name", "namespace":
			ln.Namespace = sv
		case "kubernetes.pod_name", "kubernetes_pod_name", "pod":
			ln.Pod = sv
		case "kubernetes.container_name", "kubernetes_container_name", "container":
			ln.Container = sv
		case "kubernetes.pod_node_name", "kubernetes_node_name", "node":
			ln.Node = sv
		default:
			// Anything that string-casted cleanly stays as a structured
			// field. Skip the underscore-prefixed VL internal attributes.
			if sv != "" && k != "_stream_id" && k != "_stream" {
				ln.Fields[k] = sv
			}
		}
	}
	return ln
}

// vmLogsHistogramPoint is one bucket in the volume histogram returned by
// /select/logsql/stats_query_range.
type vmLogsHistogramPoint struct {
	Ts    int64 `json:"ts"`
	Count int64 `json:"count"`
}

// queryVMLogsHistogram bins matching log lines into time buckets so the
// Logging page can render a "volume over time" chart above the search
// results. Uses the LogsQL pipe `| stats by (_time:<step>) count() rows`
// pattern which VL natively understands.
func queryVMLogsHistogram(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID, baseURL, query string,
	from, to time.Time,
	step time.Duration,
) ([]vmLogsHistogramPoint, error) {
	if step <= 0 {
		step = time.Minute
	}
	// VL accepts the search expression as `query` and the bucketing
	// step as `step`. The endpoint returns a Prometheus-style matrix
	// envelope with a single series whose value is the per-bucket
	// count.
	statsQ := fmt.Sprintf("%s | stats count() rows", query)
	u := fmt.Sprintf("%s/select/logsql/stats_query_range?query=%s&start=%d&end=%d&step=%s",
		baseURL,
		urlQueryEscape(statsQ),
		from.Unix(), to.Unix(),
		urlQueryEscape(step.String()),
	)
	resp, err := gw.SendHTTPRequest(ctx, clusterID, &proto.HTTPRequest{
		Method: http.MethodGet,
		Url:    u,
	})
	if err != nil {
		return nil, fmt.Errorf("send VL histogram query: %w", err)
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("worker VL dispatch: %s", resp.Error)
	}
	if int(resp.Status) != http.StatusOK {
		body := string(resp.Body)
		if len(body) > 200 {
			body = body[:200] + "…"
		}
		return nil, fmt.Errorf("VL HTTP %d: %s", resp.Status, body)
	}
	var env struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Values [][2]any `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Body, &env); err != nil {
		return nil, fmt.Errorf("parse VL histogram response: %w", err)
	}
	if env.Status != "success" || len(env.Data.Result) == 0 {
		return nil, nil
	}
	r := env.Data.Result[0]
	out := make([]vmLogsHistogramPoint, 0, len(r.Values))
	for _, pt := range r.Values {
		if len(pt) != 2 {
			continue
		}
		tsF, ok := pt[0].(float64)
		if !ok {
			continue
		}
		vstr, ok := pt[1].(string)
		if !ok {
			continue
		}
		c, perr := strconv.ParseInt(vstr, 10, 64)
		if perr != nil {
			continue
		}
		out = append(out, vmLogsHistogramPoint{
			Ts:    int64(tsF * 1000),
			Count: c,
		})
	}
	return out, nil
}
