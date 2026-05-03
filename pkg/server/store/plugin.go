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

func ListPlugins() ([]Plugin, error) {
	var plugins []Plugin
	// Order: built-ins first (so the "内置" group renders at the top),
	// then by category for stable grouping, then by sort_order within
	// the category (lets seed.go put VictoriaMetrics ahead of node-
	// exporter even though "n" < "v" alphabetically), with name as
	// final tie-breaker.
	if err := DB.Order("is_builtin desc, category, sort_order, name").Find(&plugins).Error; err != nil {
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

func DeletePlugin(id uint) error {
	// Cascade to per-cluster rows so we don't leave orphans pointing at a
	// missing plugin id. Built-in protection is in the handler layer.
	return DB.Transaction(func(tx *gorm.DB) error {
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

func ListClusterPlugins(clusterID string) ([]ClusterPlugin, error) {
	var rows []ClusterPlugin
	err := DB.Where("cluster_id = ?", clusterID).
		Preload("Plugin").
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
			"release_namespace_override",
			"phase",
			"message",
			"updated_at",
		}),
	}).Create(cp).Error
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
	return DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "cluster_id"}, {Name: "plugin_id"}},
		DoUpdates: clause.Assignments(updates),
	}).Create(cp).Error
}
