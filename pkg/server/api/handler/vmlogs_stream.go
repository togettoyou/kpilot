// Package handler — streaming variant of the VictoriaLogs LogsQL
// query path. Sister to vmlogs_query.go::queryVMLogs (buffered).
//
// The buffered path waits for the whole VL response before emitting
// a single SSE `result` event with `lines[]`. That is fine for tiny
// queries but turns large ones into a "blank screen → suddenly 10k
// rows" experience, and on cross-WAN tunnels the ingress 504s before
// the data ever arrives.
//
// streamVMLogs uses the P16-C gateway streaming API
// (gw.SendHTTPRequestStream) to forward VL's NDJSON response live —
// one record per `\n`-delimited JSON object. Each parsed record fires
// onLine immediately, so the caller (GetLogsSearch) can emit it as
// its own SSE `line` event without waiting. Combined with frontend
// batching (50 ms / 100 rows into virtuoso) we get real per-row UX
// even for 50k-row searches.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// maxLogLineBytes caps a single NDJSON record before we drop it. VL
// log lines can be huge (stack traces, JSON-encoded big payloads);
// 1 MiB is a comfortable ceiling that survives any realistic
// application log while still bounding worst-case server memory if
// upstream is somehow producing an unterminated giant blob. The
// dropped line is logged at warn so an operator can see the
// pathological log source.
const maxLogLineBytes = 1 << 20

// streamLogsHandler is the per-line callback. Implementations
// typically marshal the line into an SSE `line` event and return
// the write error so streamVMLogs can bail when the client
// disconnects. The cb runs on the same goroutine as the
// gateway-streaming consumer; keep it cheap.
//
// Returning a non-nil error from onLine is the signal for
// streamVMLogs to abort — critically important on the SSE path
// where a closed client conn doesn't surface fast via ctx alone:
// without this exit signal, streamVMLogs keeps consuming
// gateway-stream chunks, the consumer falls behind upstream
// production, the chunks channel fills (32-deep cap), and the
// gateway's per-worker recv loop blocks on the now-full push —
// which then stalls EVERY other request that worker owes a
// response to. Translating "client gone" into "stop iterating
// chunks NOW" prevents that cascading hang.
type streamLogsHandler func(ln vmLogLine) error

// streamVMLogs runs a LogsQL `query` over [from, to] via the
// gateway streaming path. For each complete NDJSON record observed
// on the upstream response, onLine fires with the projected
// vmLogLine. Returns the count of emitted lines, the BodyEnd error
// string from the worker (empty = clean EOF, non-empty = upstream
// truncation), and a non-nil error only on dispatch failure
// (cluster offline, VL plugin missing, HTTP non-200).
//
// limit > 0 caps the number of lines emitted; once reached we stop
// emitting and close the stream early (defer cleanup releases the
// gateway session, worker upstream connection winds down on its own
// 5 min ctx timeout — the known P16-D follow-up).
func streamVMLogs(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID, baseURL, query string,
	from, to time.Time,
	limit int,
	onLine streamLogsHandler,
) (total int, endErr string, err error) {
	if limit < 0 {
		limit = 0
	}
	u := fmt.Sprintf("%s/select/logsql/query?query=%s&start=%d&end=%d",
		baseURL,
		urlQueryEscape(query),
		from.Unix(), to.Unix(),
	)
	if limit > 0 {
		u = fmt.Sprintf("%s&limit=%d", u, limit)
	}

	stream, sErr := gw.SendHTTPRequestStream(ctx, clusterID, &gateway.HTTPRequest{
		Method: http.MethodGet,
		URL:    u,
	})
	if sErr != nil {
		return 0, "", fmt.Errorf("open VL stream: %w", sErr)
	}
	log.Printf("[diag-stream] opened cluster=%s status=%d url=%s", clusterID, stream.Status, u)
	// v2: stream.Close cascades as yamux FIN → worker cancels its
	// VL request mid-flight. ctx watcher goroutine triggers the
	// Close on cancel so Body.Read unblocks fast.
	defer func() {
		log.Printf("[diag-stream] stream.Close() invoked cluster=%s total=%d endErr=%q",
			clusterID, total, endErr)
		stream.Close()
	}()
	doneClose := make(chan struct{})
	defer close(doneClose)
	go func() {
		select {
		case <-ctx.Done():
			stream.Close()
		case <-doneClose:
		}
	}()

	if stream.Error != "" {
		return 0, "", fmt.Errorf("worker VL dispatch: %s", stream.Error)
	}
	if int(stream.Status) != http.StatusOK {
		// VL responded with a non-200 — we can't read a useful
		// body from the stream because we already consumed the
		// Start frame. Drain a little for the log, then bail.
		return 0, "", fmt.Errorf("VL HTTP %d", stream.Status)
	}

	// NDJSON line accumulator over the live stream. bytes.Buffer's
	// Next() avoids reslicing as we chew through complete lines;
	// the retained tail (incomplete final line of a chunk) waits
	// for the next Read to fill it.
	var buf bytes.Buffer
	chunk := make([]byte, 32*1024)
	overflowed := false // single-line bytes exceeded maxLogLineBytes
	var dropped int     // count of malformed / oversized lines for log

	for {
		n, rerr := stream.Body.Read(chunk)
		if n > 0 {
			c := chunk[:n]
			if overflowed {
				if i := bytes.IndexByte(c, '\n'); i >= 0 {
					buf.Reset()
					buf.Write(c[i+1:])
					overflowed = false
					dropped++
				}
			} else if buf.Len()+len(c) > maxLogLineBytes {
				overflowed = true
				buf.Reset()
				if i := bytes.IndexByte(c, '\n'); i >= 0 {
					buf.Write(c[i+1:])
					overflowed = false
					dropped++
				}
			} else {
				buf.Write(c)
				for {
					if ctx.Err() != nil {
						log.Printf("[diag-stream] EXIT via ctx.Done (inner) cluster=%s total=%d err=%v",
							clusterID, total, ctx.Err())
						return total, "ctx cancelled", ctx.Err()
					}
					idx := bytes.IndexByte(buf.Bytes(), '\n')
					if idx < 0 {
						break
					}
					rawLine := buf.Next(idx + 1)
					rawLine = bytes.TrimRight(rawLine, "\r\n")
					if len(rawLine) == 0 {
						continue
					}
					var rec map[string]any
					if jerr := json.Unmarshal(rawLine, &rec); jerr != nil {
						dropped++
						continue
					}
					if oErr := onLine(projectLogLine(rec)); oErr != nil {
						log.Printf("[diag-stream] EXIT via onLine err cluster=%s total=%d err=%v",
							clusterID, total, oErr)
						return total, "client send: " + oErr.Error(), nil
					}
					total++
					if limit > 0 && total >= limit {
						log.Printf("[diag-stream] EXIT via limit cluster=%s total=%d", clusterID, total)
						goto done
					}
				}
			}
		}
		if rerr != nil {
			if rerr != io.EOF {
				endErr = rerr.Error()
			}
			goto done
		}
	}
done:
	if dropped > 0 {
		log.Printf("[vmlogs-stream] dropped malformed/oversized lines: cluster=%s dropped=%d",
			clusterID, dropped)
	}
	return total, endErr, nil
}

