package log

import (
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap/zapcore"
)

// Entry is one log line captured into the in-process ring buffer.
// Sent over the wire (/debug/logs) as JSON and persisted by the
// server-side poller into system_logs.
//
// Seq is a monotonic uint64 set at push-time — never wraps, never
// reuses. Callers use it as a cursor: "give me lines since seq".
// When the ring overwrites old entries the seq numbers simply skip
// forward; the caller sees the gap and knows it missed some lines.
type Entry struct {
	Seq    uint64         `json:"seq"`
	TimeNs int64          `json:"ts_ns"`           // unix nanos
	Level  string         `json:"level"`           // "debug" | "info" | "warn" | "error" | ...
	Module string         `json:"module,omitempty"`
	Msg    string         `json:"msg"`
	Fields map[string]any `json:"fields,omitempty"`
}

// RingCore is a zapcore.Core that buffers entries in a fixed-capacity
// ring. Designed to sit alongside the stderr core via zapcore.NewTee
// — every log call lands in both. Hot-path cost: one mutex + one
// fields-encode + one slot copy, ~300–500 ns added to the existing
// ~1.8 µs stderr write. The trade-off is worth it because operators
// can pull the buffer over /debug/logs without grepping stderr files.
//
// Capacity is in entries, not bytes. We size it to ~50 k slots which
// at the realistic average entry size of ~250 B (msg + a few fields)
// caps memory at ~12 MB per process. Bigger isn't free — we copy
// strings into the slot, so a 1 KB msg lives in the ring forever
// until overwritten.
//
// Concurrency: a single sync.Mutex protects buf + head + count. The
// slot array is fixed at New time so the mutex protects only short
// scalar updates; we never hold it across a string allocation.
// Readers (Snapshot) take the same mutex briefly to copy the slice
// of pointers, then release before encoding to JSON, so a slow
// reader doesn't block writers.
type RingCore struct {
	zapcore.LevelEnabler // delegated to global level

	mu     sync.Mutex
	buf    []*Entry // slot ring
	head   int      // index of next write slot
	count  int      // number of valid slots (≤ cap)
	cap    int      // == len(buf)
	seq    atomic.Uint64

	// Fields shared as base context across entries (via With()).
	// zap clones the core on With(); the base ring stays shared so
	// every clone pushes into the same buffer. baseFields lives on
	// the clone, not the underlying ring.
	baseFields []zapcore.Field
}

// NewRingCore creates a ring with the given capacity. enabler should
// be the same atomic level used by the stderr core, so a single
// SetLevel call quiets both outputs.
//
// Seq anchor: the atomic counter starts at the current Unix nano,
// not 0. This is what makes the cursor protocol survive worker
// restarts. If seq started fresh at 0 on every process boot, then:
//
//   1. Server's persisted cursor (`lastSeqs[nodeID] = 500`) would
//      always be GREATER than a fresh worker's first emitted seqs
//      (1, 2, 3, ...).
//   2. The worker-side `Snapshot(since=500, ...)` filter
//      `e.Seq <= since` would drop EVERY new entry as "before
//      cursor" — they'd never make it back to the server.
//   3. Even if the cursor were reset, PG's PK (node_id, seq) would
//      conflict with the old run's rows for seq = 1..N.
//
// Anchoring at UnixNano sidesteps all three: each process boot
// starts in a numerically distinct seq region (~ns granularity is
// fine — anything bigger than the max log rate × max run duration
// works, and UnixNano gives ~10^18 of headroom). The cursor
// monotonic check then naturally accepts the new boot's seqs.
//
// Bigint headroom: UnixNano is ~1.8e18 in 2026; bigint max is
// ~9.2e18. ~5× headroom = the seq column won't overflow for ~150
// years. We're fine.
func NewRingCore(capacity int, enabler zapcore.LevelEnabler) *RingCore {
	if capacity <= 0 {
		capacity = 50_000
	}
	r := &RingCore{
		LevelEnabler: enabler,
		buf:          make([]*Entry, capacity),
		cap:          capacity,
	}
	r.seq.Store(uint64(time.Now().UnixNano()))
	return r
}

// With clones the core and appends fields. zap calls this for every
// `logger.With(...)` so cloned loggers carry per-context fields all
// the way down to Write.
func (r *RingCore) With(fields []zapcore.Field) zapcore.Core {
	clone := *r // shallow — share ring + mutex + level
	clone.baseFields = append([]zapcore.Field(nil), r.baseFields...)
	clone.baseFields = append(clone.baseFields, fields...)
	return &clone
}

// Check asks "should we accept this entry?" — same as the stderr
// core's check. Returning ce.AddCore makes zap dispatch Write to us.
func (r *RingCore) Check(ent zapcore.Entry, ce *zapcore.CheckedEntry) *zapcore.CheckedEntry {
	if r.Enabled(ent.Level) {
		return ce.AddCore(ent, r)
	}
	return ce
}

// Write captures the entry into the ring. zap calls Sync separately
// — we don't buffer beyond the slot, so Sync is a no-op for us.
func (r *RingCore) Write(ent zapcore.Entry, fields []zapcore.Field) error {
	// Encode baseFields + per-call fields into a map. MapObjectEncoder
	// is what zap's JSON encoder uses internally — handles every Field
	// type including the awkward ones (Object, Error, Stringer). Cheap:
	// the encoder is plain Go map operations + Reflect only on Object
	// fields, which we don't use in our code.
	enc := zapcore.NewMapObjectEncoder()
	for _, f := range r.baseFields {
		f.AddTo(enc)
	}
	for _, f := range fields {
		f.AddTo(enc)
	}

	e := &Entry{
		Seq:    r.seq.Add(1),
		TimeNs: ent.Time.UnixNano(),
		Level:  ent.Level.String(),
		Module: ent.LoggerName,
		Msg:    ent.Message,
		Fields: enc.Fields,
	}

	r.mu.Lock()
	r.buf[r.head] = e
	r.head = (r.head + 1) % r.cap
	if r.count < r.cap {
		r.count++
	}
	r.mu.Unlock()
	return nil
}

// Sync is a no-op — entries live in RAM, nothing to flush.
func (r *RingCore) Sync() error { return nil }

// Snapshot returns entries with seq > sinceSeq, up to `limit` items,
// oldest first. Pass sinceSeq=0 to get the whole buffer.
//
// Used by /debug/logs. Cursor semantics:
//
//	resp, _ := pollLogs(node, sinceSeq=lastSeen)
//	lastSeen = resp[len(resp)-1].Seq   // next call starts from here
//
// If lastSeen lags behind the ring's overwrite point, the gap shows
// up in the returned slice as a seq jump — the caller can log "skipped
// N entries" or just continue. We don't fabricate a synthetic "gap"
// record; that's a renderer concern.
func (r *RingCore) Snapshot(sinceSeq uint64, limit int) []*Entry {
	if limit <= 0 {
		limit = r.cap
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.count == 0 {
		return nil
	}
	// Oldest slot: when count == cap, head points to it (next-write
	// slot is also the oldest valid one in a full ring). When not
	// full, the oldest slot is index 0.
	oldest := 0
	if r.count == r.cap {
		oldest = r.head
	}
	out := make([]*Entry, 0, min(limit, r.count))
	for i := 0; i < r.count && len(out) < limit; i++ {
		idx := (oldest + i) % r.cap
		e := r.buf[idx]
		if e == nil || e.Seq <= sinceSeq {
			continue
		}
		out = append(out, e)
	}
	return out
}

// LastSeq returns the most recent assigned seq number (or 0 if no
// entries yet). Useful as a starting cursor for a fresh subscriber
// that only wants new lines.
func (r *RingCore) LastSeq() uint64 {
	return r.seq.Load()
}

// FormatTime is a convenience for callers that want the entry timestamp
// as time.Time (renderers, sorters). Pulled out so we don't pollute
// every Entry with a parsed time.Time field.
func (e *Entry) Time() time.Time { return time.Unix(0, e.TimeNs) }
