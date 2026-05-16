package store

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ─── Plugin (registry) ─────────────────────────────────────────────────────

func CreatePlugin(p *Plugin) error {
	return DB.Create(p).Error
}

func GetPluginByID(id uint) (*Plugin, error) {
	var p Plugin
	if err := DB.Preload("ChartBlob").First(&p, id).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

func GetPluginByName(name string) (*Plugin, error) {
	var p Plugin
	if err := DB.Where("name = ?", name).Preload("ChartBlob").First(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// ListPluginsBrief returns plugin rows without the heavy `default_values`
// blob (a 64 KiB cap per row, typically a few KiB but spikey). The list
// endpoints only need metadata for cards / table rows; full values are
// fetched on demand by the editor / enable drawer via GetPluginByID.
// Order: built-ins first (so the "内置" group renders at the top), then
// by category for stable grouping, then by sort_order within the
// category (lets seed.go put VictoriaMetrics ahead of node-exporter
// even though "n" < "v" alphabetically), with name as final tie-breaker.
// without re-sorting on the frontend.
func ListPluginsBrief() ([]Plugin, error) {
	var plugins []Plugin
	if err := DB.
		Omit("default_values").
		Order("is_builtin desc, category, sort_order, name").
		Find(&plugins).Error; err != nil {
		return nil, err
	}
	return plugins, nil
}

// UpdatePlugin updates a plugin's user-editable fields. Caller must check
// is_builtin upstream — we don't enforce immutability here.
func UpdatePlugin(id uint, updates map[string]any) error {
	updates["updated_at"] = time.Now()
	return DB.Model(&Plugin{}).Where("id = ?", id).Updates(updates).Error
}

// ErrPluginInUse is returned by DeletePlugin when at least one cluster
// still has the plugin in a non-Disabled phase. Distinguishable from
// other DB errors so the handler can surface a 409 / PLUGIN_IN_USE.
var ErrPluginInUse = errors.New("plugin is in use by at least one cluster")

func DeletePlugin(id uint) error {
	// Cascade to per-cluster rows so we don't leave orphans pointing at a
	// missing plugin id. The in-use check has to happen INSIDE the same
	// transaction — checking outside would race with a concurrent
	// EnablePlugin (the SELECT could come back empty, then a row gets
	// inserted, then we cascade-drop it under the running release).
	// Built-in protection is in the handler layer.
	return DB.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&ClusterPlugin{}).
			Where("plugin_id = ? AND phase != ?", id, PluginPhaseDisabled).
			Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrPluginInUse
		}
		if err := tx.Where("plugin_id = ?", id).Delete(&ClusterPlugin{}).Error; err != nil {
			return err
		}
		return tx.Delete(&Plugin{}, id).Error
	})
}

func PluginNameExists(name string) (bool, error) {
	var count int64
	if err := DB.Model(&Plugin{}).Where("name = ?", name).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

var ErrPluginNotFound = gorm.ErrRecordNotFound

// ─── PluginBlob (uploaded .tgz) ─────────────────────────────────────────────

// UpsertPluginBlob inserts the blob if no row with the same sha256 exists,
// otherwise returns the existing one (dedupe by content).
func UpsertPluginBlob(b *PluginBlob) error {
	var existing PluginBlob
	err := DB.Where("sha256 = ?", b.SHA256).First(&existing).Error
	if err == nil {
		*b = existing
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	b.UploadedAt = time.Now()
	return DB.Create(b).Error
}

func GetPluginBlobByID(id uint) (*PluginBlob, error) {
	var b PluginBlob
	if err := DB.First(&b, id).Error; err != nil {
		return nil, err
	}
	return &b, nil
}

// ─── ClusterPlugin (per-cluster install state) ──────────────────────────────

func GetClusterPlugin(clusterID string, pluginID uint) (*ClusterPlugin, error) {
	var cp ClusterPlugin
	err := DB.Where("cluster_id = ? AND plugin_id = ?", clusterID, pluginID).
		Preload("Plugin").Preload("Plugin.ChartBlob").First(&cp).Error
	if err != nil {
		return nil, err
	}
	return &cp, nil
}

// ListClusterPlugins returns the per-cluster install state rows. The
// HTTP handler (`ListClusterPlugins` in handler/plugin.go) joins
// these against `ListPluginsBrief` client-side, so we don't preload
// the Plugin relation here — preloading would ship the 64KiB
// `default_values` blob per row over the DB connection on every UI
// poll for nothing. The gateway's replay path looks up the Plugin
// it actually needs by id via `GetPluginByID`.
func ListClusterPlugins(clusterID string) ([]ClusterPlugin, error) {
	var rows []ClusterPlugin
	err := DB.Where("cluster_id = ?", clusterID).
		Order("updated_at desc").Find(&rows).Error
	return rows, err
}

// UpsertClusterPlugin creates or updates the row for (cluster, plugin)
// atomically via Postgres ON CONFLICT, so two enable clicks racing on
// the same key don't end with the second hitting a unique-violation
// 500. Used by both the enable handler (sets enabled + overrides +
// Phase=Pending) and elsewhere when a row is fully overwritten.
func UpsertClusterPlugin(cp *ClusterPlugin) error {
	now := time.Now()
	if cp.CreatedAt.IsZero() {
		cp.CreatedAt = now
	}
	cp.UpdatedAt = now
	return DB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "cluster_id"}, {Name: "plugin_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"enabled",
			"version_override",
			"values_override",
			"phase",
			"message",
			"updated_at",
		}),
	}).Create(cp).Error
}

// DeleteDisabledClusterPlugin removes the per-cluster row for (cluster,
// plugin) — but only if the row's `enabled` is already false.
//
// Used after a successful uninstall: once the Helm release is gone,
// keeping the row around just leaks the previous values_override and
// shows up confusingly when the user re-enables ("why does the form
// already have my old YAML?"). Deleting collapses Disabled state to
// "no row at all" so re-enable starts from registry defaults.
//
// The `enabled = false` predicate avoids races: if the user clicked
// Disable then Enable in quick succession, the new EnablePlugin will
// have set enabled=true with fresh overrides; when the lingering
// uninstall status push from the OLD command lands here, this
// predicate matches 0 rows and the new state is preserved.
func DeleteDisabledClusterPlugin(clusterID string, pluginID uint) (bool, error) {
	res := DB.Where("cluster_id = ? AND plugin_id = ? AND enabled = ?",
		clusterID, pluginID, false).Delete(&ClusterPlugin{})
	return res.RowsAffected > 0, res.Error
}

// UpdateClusterPluginStatus is a partial update used by PluginStatusPush
// handling — it never touches user-controlled fields (enabled, overrides).
func UpdateClusterPluginStatus(clusterID string, pluginID uint, updates map[string]any) error {
	updates["updated_at"] = time.Now()
	return DB.Model(&ClusterPlugin{}).
		Where("cluster_id = ? AND plugin_id = ?", clusterID, pluginID).
		Updates(updates).Error
}

// UpsertClusterPluginStatus mirrors UpdateClusterPluginStatus but inserts
// a synthetic row when none exists for (cluster, plugin). Self-heals the
// edge case where the enable handler successfully pushed to the Worker
// but the subsequent ClusterPlugin row write failed: when the Worker's
// status push lands here, we record what we know rather than dropping
// the update. The new row is marked enabled iff the phase implies the
// release exists on the cluster (anything other than Disabled).
func UpsertClusterPluginStatus(clusterID string, pluginID uint, phase PluginPhase, updates map[string]any) error {
	return upsertClusterPluginStatusOn(DB, clusterID, pluginID, phase, updates)
}

func upsertClusterPluginStatusOn(db *gorm.DB, clusterID string, pluginID uint, phase PluginPhase, updates map[string]any) error {
	now := time.Now()
	cp := &ClusterPlugin{
		ClusterID: clusterID,
		PluginID:  pluginID,
		Enabled:   phase != PluginPhaseDisabled,
		Phase:     phase,
		CreatedAt: now,
		UpdatedAt: now,
	}
	// Apply the same fields the UPDATE path would have set, so the
	// inserted row reflects what the Worker just reported.
	if v, ok := updates["message"].(string); ok {
		cp.Message = v
	}
	if v, ok := updates["observed_version"].(string); ok {
		cp.ObservedVersion = v
	}
	if v, ok := updates["observed_values_hash"].(string); ok {
		cp.ObservedValuesHash = v
	}
	if v, ok := updates["helm_revision"].(int32); ok {
		cp.HelmRevision = v
	}
	if v, ok := updates["installed_at"].(*time.Time); ok {
		cp.InstalledAt = v
	}
	updates["updated_at"] = now
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "cluster_id"}, {Name: "plugin_id"}},
		DoUpdates: clause.Assignments(updates),
	}).Create(cp).Error
}

// PersistClusterPluginStatusIfActive atomically reads the row, applies
// the "don't downgrade a user-disabled row to a non-Uninstalling phase"
// predicate, and upserts the new state — all inside one DB transaction
// so a concurrent EnablePlugin can't slip in between the read and the
// write and have its row clobbered by a late status echo from the
// previous Disable.
//
// `phase == Uninstalling` is the legal transitional phase during a
// disable in progress — that one is allowed through even when the row
// has `enabled=false` already.
//
// Returns (skipped=true, nil) when the predicate filtered the update
// out so callers can log "echo ignored" if they want. (false, nil) on
// successful write; (_, err) on DB error.
func PersistClusterPluginStatusIfActive(clusterID string, pluginID uint, phase PluginPhase, updates map[string]any) (skipped bool, err error) {
	err = DB.Transaction(func(tx *gorm.DB) error {
		var existing ClusterPlugin
		err := tx.Where("cluster_id = ? AND plugin_id = ?", clusterID, pluginID).
			First(&existing).Error
		if err == nil && !existing.Enabled && phase != PluginPhaseUninstalling {
			skipped = true
			return nil
		}
		// gorm.ErrRecordNotFound is fine — the upsert will INSERT.
		return upsertClusterPluginStatusOn(tx, clusterID, pluginID, phase, updates)
	})
	return skipped, err
}
