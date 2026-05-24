// Package store — system-monitoring snapshot persistence.
//
// system_snapshots is a high-churn time-series table: the diag
// poller INSERTs one row per node every 15 s and a TTL janitor
// DELETEs rows older than ~1 h. Steady state is ~12k rows for a
// 50-cluster deployment.
//
// Snapshot is stored as raw JSONB bytes. We never query individual
// fields server-side (the frontend parses the JSON and picks what
// it needs), so we avoid the schema-migration burden of having one
// column per metric. JSONB also TOAST-compresses well because of
// repeated JSON key names.
package store

import "time"

// SystemSnapshot is one point-in-time poll of a single node.
// NodeID is either the literal "server" or a worker's cluster_id
// (UUID). At is when the poll was assembled (UTC). Snapshot is the
// full JSON the poller fetched from the node's /debug/snapshot
// endpoint — opaque to this layer.
//
// Primary key is composite (node_id, at) — natural unique identity
// (one poll per node per timestamp) instead of a synthetic id.
// No other table FKs into this one, the API never returns row
// identifiers, and the table is strictly append + TTL-delete; a
// surrogate id was pure overhead (extra column + extra PK btree).
// The composite PK also serves the per-node range queries (it IS
// the index on `(node_id, at)`), so we drop the previously
// separate idx_sys_snap_node_at. Only idx_sys_snap_at on `(at)`
// alone remains, for the TTL DELETE.
type SystemSnapshot struct {
	NodeID   string    `gorm:"primaryKey;size:64"`
	At       time.Time `gorm:"primaryKey;index:idx_sys_snap_at"`
	Snapshot []byte    `gorm:"type:jsonb;not null"`
}

// TableName keeps the singular-Go-name → snake-plural-table rule
// implicit elsewhere; explicit here so future renames don't break
// existing prod tables.
func (SystemSnapshot) TableName() string { return "system_snapshots" }

// InsertSystemSnapshot writes one row. Used by the diag poller
// (exactly one writer per node in steady state).
func InsertSystemSnapshot(nodeID string, at time.Time, snapshot []byte) error {
	return DB.Create(&SystemSnapshot{
		NodeID:   nodeID,
		At:       at,
		Snapshot: snapshot,
	}).Error
}

// LatestSystemSnapshots returns the latest row per distinct node_id
// in one query. Postgres-specific DISTINCT ON gets us the "max(at)
// per group" without a self-join. Used by the landing page's batch
// /system/snapshots endpoint.
func LatestSystemSnapshots() ([]SystemSnapshot, error) {
	var rows []SystemSnapshot
	err := DB.Raw(
		`SELECT DISTINCT ON (node_id) node_id, at, snapshot
		   FROM system_snapshots
		   ORDER BY node_id, at DESC`,
	).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// SystemSnapshotsSince returns rows for one node with at > since,
// chronologically ascending so the frontend can append directly to
// its local ring. Bounded by limit (typical: 240 for a 1 h window).
// since == zero time means "from the oldest available row in the
// table" (caller asks for full history).
//
// Pagination strategy: ORDER BY at DESC LIMIT N (keep the NEWEST
// N rows when matched > limit), then reverse client-side so the
// returned slice is still ASC. Doing it the other way (ASC LIMIT N)
// would cut off the freshest data — invisible in the normal case
// where matched ≈ limit, but biting on URL-hack `?since=2h-ago`
// against a 1 h retention window.
func SystemSnapshotsSince(nodeID string, since time.Time, limit int) ([]SystemSnapshot, error) {
	if limit <= 0 || limit > 10_000 {
		limit = 240
	}
	q := DB.Where("node_id = ?", nodeID)
	if !since.IsZero() {
		q = q.Where("at > ?", since)
	}
	var rows []SystemSnapshot
	if err := q.Order("at DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	// Reverse to ASC. Cheap (≤ limit rows, just a slice swap loop).
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, nil
}

// SystemSnapshotsRange returns rows for one node within [from, to],
// uniformly down-sampled to at most maxRows. The frontend uses this
// for the "view last N hours" range picker; capping output keeps the
// JSON response and downstream chart-render cost bounded regardless
// of how wide the range is.
//
// Sampling strategy: ROW_NUMBER() over the matched range, then keep
// every (matched / maxRows)-th row using mod. Postgres-side — we
// never ship the full row set to Go just to throw most of them away.
// Always includes the latest row so the chart's right edge is fresh.
//
// from defaults to (to - 1h) when zero. to defaults to now() when
// zero. maxRows ≤ 0 falls back to 240.
func SystemSnapshotsRange(nodeID string, from, to time.Time, maxRows int) ([]SystemSnapshot, error) {
	if to.IsZero() {
		to = time.Now().UTC()
	}
	if from.IsZero() {
		from = to.Add(-1 * time.Hour)
	}
	if maxRows <= 0 || maxRows > 5_000 {
		maxRows = 240
	}

	// Two-step: count matched, decide step, run the filtered query.
	// One extra round-trip vs a clever single CTE, but keeps the
	// SQL readable + avoids edge cases when matched < maxRows.
	var matched int64
	if err := DB.Model(&SystemSnapshot{}).
		Where("node_id = ? AND at >= ? AND at <= ?", nodeID, from, to).
		Count(&matched).Error; err != nil {
		return nil, err
	}
	if matched == 0 {
		return nil, nil
	}

	step := int64(1)
	if matched > int64(maxRows) {
		step = matched / int64(maxRows)
		if step < 1 {
			step = 1
		}
	}

	// `rn % step = 0` picks every step-th row. rn starts at 1 so
	// the OLDEST row in the range gets rn=1 → always sampled when
	// step | (matched-1). The very latest row may or may not land on
	// the modulo grid; we union it in explicitly so the right edge
	// of the chart is always current.
	var rows []SystemSnapshot
	err := DB.Raw(
		`WITH ranked AS (
		   SELECT node_id, at, snapshot,
		          ROW_NUMBER() OVER (ORDER BY at ASC) AS rn,
		          COUNT(*)    OVER ()                  AS total
		     FROM system_snapshots
		    WHERE node_id = ? AND at >= ? AND at <= ?
		 )
		 SELECT node_id, at, snapshot
		   FROM ranked
		  WHERE rn % ? = 0 OR rn = total
		  ORDER BY at ASC`,
		nodeID, from, to, step,
	).Scan(&rows).Error
	return rows, err
}

// DeleteSystemSnapshotsBefore removes rows older than the cutoff.
// Returns the number of rows deleted so the janitor can log a
// meaningful "trimmed N rows" line. Uses the idx_sys_snap_at index
// for the WHERE so cost stays in the ms range even with many rows.
func DeleteSystemSnapshotsBefore(cutoff time.Time) (int64, error) {
	tx := DB.Where("at < ?", cutoff).Delete(&SystemSnapshot{})
	return tx.RowsAffected, tx.Error
}
