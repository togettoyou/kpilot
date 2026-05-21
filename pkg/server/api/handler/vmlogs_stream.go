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
// typically marshal the line into an SSE `line` event. The cb is
// invoked on the same goroutine as the gateway recv loop's pusher
// (via the chunks channel) — keep it cheap (no blocking I/O).
type streamLogsHandler func(ln vmLogLine)

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
	// MUST defer Close — otherwise a slow consumer / early return
	// leaves the gateway session registered and stalls the worker
	// recv loop on its bounded chunks channel.
	defer stream.Close()

	if stream.Error != "" {
		return 0, "", fmt.Errorf("worker VL dispatch: %s", stream.Error)
	}
	if int(stream.Status) != http.StatusOK {
		// VL responded with a non-200 — we can't read a useful
		// body from the stream because we already consumed the
		// Start frame. Drain a little for the log, then bail.
		return 0, "", fmt.Errorf("VL HTTP %d", stream.Status)
	}

	// NDJSON line accumulator. bytes.Buffer.Next() avoids reslicing
	// and re-allocations as we chew through complete lines; the
	// retained tail (incomplete final line of a chunk) is kept for
	// the next chunk to prepend to.
	var buf bytes.Buffer
	overflowed := false // single-line bytes exceeded maxLogLineBytes
	var dropped int     // count of malformed / oversized lines for log

	for {
		select {
		case chunk, ok := <-stream.Chunks:
			if !ok {
				// BodyEnd already arrived; drain endErr (non-blocking,
				// gateway finalised it before closing chunks).
				if e := <-stream.EndErr; e != nil {
					endErr = e.Error()
				}
				goto done
			}
			// Defensive size guard: protect server memory against a
			// pathological upstream that emits one unterminated blob.
			// If we've already overflowed, drop incoming bytes until
			// we see a \n boundary that lets us resync.
			if overflowed {
				if i := bytes.IndexByte(chunk, '\n'); i >= 0 {
					buf.Reset()
					buf.Write(chunk[i+1:])
					overflowed = false
					dropped++
				}
				continue
			}
			if buf.Len()+len(chunk) > maxLogLineBytes {
				overflowed = true
				buf.Reset()
				// drop this chunk; resync on next \n
				if i := bytes.IndexByte(chunk, '\n'); i >= 0 {
					buf.Write(chunk[i+1:])
					overflowed = false
					dropped++
				}
				continue
			}
			buf.Write(chunk)
			for {
				idx := bytes.IndexByte(buf.Bytes(), '\n')
				if idx < 0 {
					break
				}
				rawLine := buf.Next(idx + 1) // includes trailing \n
				rawLine = bytes.TrimRight(rawLine, "\r\n")
				if len(rawLine) == 0 {
					continue
				}
				var rec map[string]any
				if jerr := json.Unmarshal(rawLine, &rec); jerr != nil {
					dropped++
					continue
				}
				onLine(projectLogLine(rec))
				total++
				if limit > 0 && total >= limit {
					// Caller asked for a hard cap — stop forwarding.
					// Deferred stream.Close releases the gateway
					// session; the worker's upstream HTTP request
					// cancels via its own ctx.Done eventually.
					goto done
				}
			}
		case <-ctx.Done():
			return total, "ctx cancelled", ctx.Err()
		}
	}
done:
	if dropped > 0 {
		log.Printf("[vmlogs-stream] dropped malformed/oversized lines: cluster=%s dropped=%d",
			clusterID, dropped)
	}
	return total, endErr, nil
}

