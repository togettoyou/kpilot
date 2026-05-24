// Package store — system-log persistence.
//
// system_logs sits next to system_snapshots: same poller pattern
// (single writer per node, TTL janitor), same retention (~1 day),
// but row-per-line instead of row-per-poll. Worker + server emit
// log entries into an in-process ring buffer (pkg/log.RingCore),
// the server-side LogsPoller pulls /debug/logs every 5 s and
// batch-INSERTs whatever's new since last cursor.
//
// Volume estimate: 50 nodes × ~10 lines/s steady state = 500
// INSERT/s peak (worst case with debug logging on). At ~250 B/row
// that's ~10 GB/day raw, ~5 GB/day after JSONB TOAST compression
// of the Fields column. The 25 h retention janitor keeps the table
// bounded. Heavy debug logging in production isn't free — operators
// who flip KPILOT_LOG_LEVEL=debug knowingly pay this.
package store

import (
	"time"
)

// SystemLog is one log entry from the in-process ring buffer of a
// single node. NodeID is the literal "server" or a worker's
// cluster_id (UUID). Seq is the per-node monotonic counter assigned
// by pkg/log.RingCore (atomic.Uint64). It exists primarily because
// the worker's /debug/logs?since=<n> protocol needs a stable cursor:
// wall-clock at can collide at ns precision under bursty writes and
// can regress on NTP correction, so it's not a safe cursor. Once we
// have seq for the cursor anyway, persisting it as the composite PK
// (node_id, seq) is just consistency — no surrogate id needed.
//
// At is the wall-clock timestamp, indexed for the TTL janitor and
// time-range queries. We index (node_id, at DESC) composite (not
// just (at) on its own) because the dominant read pattern is
// "rows for this node in this window".
//
// Level is stored as int8 for cheap WHERE level >= ? filtering:
//
//	-1 = debug   0 = info   1 = warn   2 = error   3 = fatal
//
// matches zap's zapcore.Level. Module is the dotted module name
// (gateway, http-proxy, handler.model, ...). Fields is the raw JSON
// of any structured KV pairs the call site passed; Msg is the human
// message.
//
// Indexes (the GORM tag composite-index syntax is `index:name,...`
// with priority controlling field order):
//
//   - PK (node_id, seq)              — cursor reads + uniqueness
//   - idx_sys_log_node_at composite  — (node_id, at DESC) for range
//                                       queries by node + time window
//   - idx_sys_log_at                 — (at) alone for the TTL janitor
//                                       (matches WHERE at < cutoff
//                                       without needing node_id)
//
// We deliberately do NOT index level alone (only 4 distinct values,
// useless cardinality) or module alone (almost always queried in
// combination with node_id, and the prefix-match `module LIKE 'x.%'`
// query already lives within a node-at index seek so filtering
// module sequentially within that range is cheap at our scale).
type SystemLog struct {
	NodeID string    `gorm:"primaryKey;size:64;index:idx_sys_log_node_at,priority:1"`
	Seq    uint64    `gorm:"primaryKey;autoIncrement:false"`
	At     time.Time `gorm:"index:idx_sys_log_node_at,priority:2,sort:desc;index:idx_sys_log_at;not null"`
	Level  int8      `gorm:"not null"`
	Module string    `gorm:"size:64;not null"`
	Msg    string    `gorm:"type:text;not null"`
	Fields []byte    `gorm:"type:jsonb"`
}

func (SystemLog) TableName() string { return "system_logs" }

// ParseLogLevel maps the zap level string ("debug" / "info" / "warn" /
// "error" / "dpanic" / "panic" / "fatal") to the int8 used in the
// `level` column. Unknown strings map to info — preserves rows when
// future zap versions add levels we don't recognize.
func ParseLogLevel(s string) int8 {
	switch s {
	case "debug":
		return -1
	case "info":
		return 0
	case "warn":
		return 1
	case "error":
		return 2
	case "dpanic", "panic", "fatal":
		return 3
	default:
		return 0
	}
}

// LevelString is the inverse — used by the API handler when serving
// rows to the frontend.
func LevelString(l int8) string {
	switch {
	case l <= -1:
		return "debug"
	case l == 0:
		return "info"
	case l == 1:
		return "warn"
	case l == 2:
		return "error"
	default:
		return "fatal"
	}
}

// BatchInsertSystemLogs writes a slice of rows in a single INSERT.
// Used by the LogsPoller, which pulls /debug/logs from each node
// every 5 s and dumps the result here. CreateInBatches caps the
// per-statement size at 500: with 7 columns that's 3500 parameters,
// well under Postgres' 65 535 cap, and keeps individual statement
// latency bounded.
//
// No ON CONFLICT handling: the poller is the only writer per node
// and tracks lastSeq carefully, so duplicate (node_id, seq) writes
// would indicate a bug in the cursor logic we WANT to see surface.
// Silently swallowing PK violations would hide it.
func BatchInsertSystemLogs(rows []SystemLog) error {
	if len(rows) == 0 {
		return nil
	}
	return DB.CreateInBatches(rows, 500).Error
}

// GetLatestSystemLogSeq returns the highest seq number persisted for
// the given node, or 0 if no rows exist yet. Used by the poller at
// startup to skip already-persisted entries — without this it would
// re-fetch from seq=0 on every restart and accumulate duplicate
// rows until ON CONFLICT (which we don't use) or the unique PK
// erroring out.
func GetLatestSystemLogSeq(nodeID string) (uint64, error) {
	var seq uint64
	err := DB.Model(&SystemLog{}).
		Where("node_id = ?", nodeID).
		Select("COALESCE(MAX(seq), 0)").
		Scan(&seq).Error
	return seq, err
}

// SystemLogFilter narrows the QuerySystemLogs result set. All fields
// are optional and combined with AND.
//
//	NodeID    — exact (required if you want logs for one node).
//	From / To — at range; ignored when zero.
//	Level     — minimum level (e.g. 1 == warn → returns warn+error+fatal).
//	            -10 sentinel means "no level filter" (so callers can
//	            pass 0 explicitly to mean info-and-above).
//	Module    — exact match OR prefix (passing "handler" matches
//	            "handler" + "handler.model" + "handler.volcano" via
//	            module LIKE 'handler%'). Empty == all modules.
//	Q         — case-insensitive substring on Msg.
//	AfterSeq  — return rows with seq > AfterSeq (per-node). Pair with
//	            NodeID for the "live tail" use case. When NodeID is
//	            empty AfterSeq is ignored (would be ambiguous).
//	Limit     — cap rows; defaults to 500 if ≤ 0. Hard cap 5 000.
type SystemLogFilter struct {
	NodeID   string
	From, To time.Time
	Level    int8
	Module   string
	Q        string
	AfterSeq uint64
	Limit    int
}

// SystemLogLevelAny is the sentinel for "don't filter by level".
// Zero would mean "info and above"; this value sits below the
// possible range so the filter logic can distinguish "explicit 0"
// from "not set".
const SystemLogLevelAny int8 = -10

// QuerySystemLogs returns rows matching the filter, newest first.
// Newest-first ordering matches the user's intent for log browsing
// (you want "what just happened" at the top); the frontend can
// reverse if it wants to render chronologically.
func QuerySystemLogs(f SystemLogFilter) ([]SystemLog, error) {
	q := DB.Model(&SystemLog{})
	if f.NodeID != "" {
		q = q.Where("node_id = ?", f.NodeID)
	}
	if !f.From.IsZero() {
		q = q.Where("at >= ?", f.From)
	}
	if !f.To.IsZero() {
		q = q.Where("at <= ?", f.To)
	}
	if f.Level != SystemLogLevelAny {
		q = q.Where("level >= ?", f.Level)
	}
	if f.Module != "" {
		// Prefix match — `handler` should hit `handler.model` too.
		// LIKE escape isn't needed because module names are
		// strictly [a-z0-9.-] (set at L() time, not user input).
		q = q.Where("module = ? OR module LIKE ?", f.Module, f.Module+".%")
	}
	if f.Q != "" {
		q = q.Where("msg ILIKE ?", "%"+f.Q+"%")
	}
	if f.AfterSeq > 0 && f.NodeID != "" {
		q = q.Where("seq > ?", f.AfterSeq)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 500
	}
	// Hard cap 10 000. The frontend picker exposes 100/1k/5k/10k; the
	// cap is the absolute ceiling that bounds JSON encode time
	// (~10 ms at 10k rows) and response size (~1 MB at typical row
	// width). Going higher would push browser parse + initial paint
	// over a perceptible threshold without giving operators a
	// usefully different view than "many recent lines".
	if limit > 10000 {
		limit = 10000
	}
	var rows []SystemLog
	err := q.Order("at DESC, seq DESC").Limit(limit).Find(&rows).Error
	return rows, err
}

// DistinctSystemLogModules returns the distinct module names present
// in the table, optionally filtered to a single node. Used by the
// frontend module picker on /system/logs — when the picker shows
// modules for "server", only server-emitted module names are
// relevant (worker tunnel internals would just confuse the user),
// and vice versa.
//
// Cost: with nodeID set, PK (node_id, seq) seek narrows the scan
// to one node's rows (~100k for a day's retention) before the
// DISTINCT collapse — typically <10 ms. Without nodeID it falls
// back to a whole-table scan + hash distinct, which on a busy
// multi-cluster deployment can be hundreds of ms. Prefer the
// node-scoped form.
//
// Empty nodeID = no filter (returns all modules across all nodes).
// Kept as a fallback for callers that genuinely want the union.
func DistinctSystemLogModules(nodeID string) ([]string, error) {
	q := DB.Model(&SystemLog{})
	if nodeID != "" {
		q = q.Where("node_id = ?", nodeID)
	}
	var rows []string
	err := q.Distinct("module").Order("module ASC").Pluck("module", &rows).Error
	return rows, err
}

// DeleteSystemLogsBefore removes rows older than cutoff. Used by the
// LogsPoller janitor. Returns rows-affected so the janitor can log
// a "trimmed N rows" line at info.
func DeleteSystemLogsBefore(cutoff time.Time) (int64, error) {
	tx := DB.Where("at < ?", cutoff).Delete(&SystemLog{})
	return tx.RowsAffected, tx.Error
}
