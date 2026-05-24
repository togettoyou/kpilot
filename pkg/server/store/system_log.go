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
// by pkg/log.RingCore — never repeats, never wraps. The composite
// PK (node_id, seq) is the natural identity; one entry per node per
// seq, and seq itself sorts entries within a node chronologically
// (atomic counter, set under no lock, so it's monotonic even across
// goroutines on the source process).
//
// At duplicates the timestamp also encoded in the entry, but having
// it as a column means we can index it for the TTL janitor and the
// /api/v1/system/:node/logs?from=&to= range query. Going through
// JSONB extraction for those would be 10×+ slower.
//
// Level is stored as int8 for cheap WHERE level >= ? filtering
// (avoid string comparisons in the index). Mapping:
//
//	-1 = debug   0 = info   1 = warn   2 = error
//
// matches zap's zapcore.Level. Module is the dotted module name
// (gateway, http-proxy, handler.model, ...). Fields is the raw JSON
// of any structured KV pairs the call site passed. Msg is the human
// message.
type SystemLog struct {
	NodeID string    `gorm:"primaryKey;size:64"`
	Seq    uint64    `gorm:"primaryKey;autoIncrement:false"`
	At     time.Time `gorm:"index:idx_sys_log_at;not null"`
	Level  int8      `gorm:"index:idx_sys_log_node_level;not null"`
	Module string    `gorm:"size:64;index:idx_sys_log_node_module;not null"`
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
// per-statement size so very long bursts don't blow Postgres'
// parameter limit (~65 535 parameters per statement; with 7
// columns that's ~9 300 rows per chunk — we use 500 for safety
// margin and to keep individual statement latency bounded).
//
// Idempotent on the composite PK: if the poller re-fetches an
// already-persisted slice (e.g. after a crash mid-flush), ON CONFLICT
// DO NOTHING keeps the insert from failing. We use plain Create
// here and rely on the poller to track its last-seen cursor correctly;
// the safety net would be ON CONFLICT, but in practice the cursor
// logic is the contract and we want a Postgres error to surface
// real bugs rather than silently swallowing duplicates.
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
	if limit > 5000 {
		limit = 5000
	}
	var rows []SystemLog
	err := q.Order("at DESC, seq DESC").Limit(limit).Find(&rows).Error
	return rows, err
}

// DistinctSystemLogModules returns the distinct module names present
// in the table — used by the frontend module-picker. Ordered by
// alphabetic name. Includes empty string entries (the unnamed root
// logger) explicitly because operators may want to filter "no module"
// noise. Cheap query: scans the (node_id, module) index, dedups.
func DistinctSystemLogModules() ([]string, error) {
	var rows []string
	err := DB.Model(&SystemLog{}).
		Distinct("module").
		Order("module ASC").
		Pluck("module", &rows).Error
	return rows, err
}

// DeleteSystemLogsBefore removes rows older than cutoff. Used by the
// LogsPoller janitor. Returns rows-affected so the janitor can log
// a "trimmed N rows" line at info.
func DeleteSystemLogsBefore(cutoff time.Time) (int64, error) {
	tx := DB.Where("at < ?", cutoff).Delete(&SystemLog{})
	return tx.RowsAffected, tx.Error
}
