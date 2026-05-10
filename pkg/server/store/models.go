package store

import (
	"time"
)

type ClusterStatus string

const (
	ClusterStatusOffline ClusterStatus = "offline"
	ClusterStatusOnline  ClusterStatus = "online"
)

type Cluster struct {
	ID          string        `gorm:"primaryKey;type:varchar(36)" json:"id"`
	Name        string        `gorm:"type:varchar(255);not null;uniqueIndex" json:"name"`
	Token       string        `gorm:"type:varchar(255);not null;uniqueIndex" json:"-"`
	Status      ClusterStatus `gorm:"type:varchar(20);not null;default:'offline'" json:"status"`
	Description string        `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
}

// PluginPhase is the lifecycle state of a per-cluster Helm release.
// "Disabled" is the implicit state when no ClusterPlugin row exists or
// enabled=false; the rest mirror the CRD's status.phase.
type PluginPhase string

const (
	PluginPhaseDisabled     PluginPhase = "Disabled"
	PluginPhasePending      PluginPhase = "Pending"
	PluginPhaseInstalling   PluginPhase = "Installing"
	PluginPhaseUpgrading    PluginPhase = "Upgrading"
	PluginPhaseRunning      PluginPhase = "Running"
	PluginPhaseFailed       PluginPhase = "Failed"
	PluginPhaseUninstalling PluginPhase = "Uninstalling"
)

// ChartType selects how the Helm chart is sourced.
type ChartType string

const (
	ChartTypeRepo  ChartType = "repo"  // traditional Helm repo (https + index.yaml), pulled at install time
	ChartTypeLocal ChartType = "local" // .tgz cached on Worker by sha256
	ChartTypeOCI   ChartType = "oci"   // OCI registry (oci://...), Helm 3.8+; chart_repo holds full URL, chart_name unused
)

// PluginCategory groups plugins in the registry UI. Built-in plugins use a
// fixed category; custom plugins default to "custom" but the user can pick
// any string when creating them.
type PluginCategory string

const (
	PluginCategoryGPU        PluginCategory = "gpu"
	PluginCategoryScheduling PluginCategory = "scheduling"
	PluginCategoryNetworking PluginCategory = "networking"
	PluginCategoryStorage    PluginCategory = "storage"
	PluginCategoryMonitoring PluginCategory = "monitoring"
	PluginCategoryLogging    PluginCategory = "logging"
	PluginCategorySecurity   PluginCategory = "security"
	PluginCategoryServing    PluginCategory = "serving"
	PluginCategoryCustom     PluginCategory = "custom"
)

// Plugin is the GLOBAL registry entry — one Helm chart definition shared
// across all clusters. Built-in plugins are seeded at startup and are
// immutable (handlers reject edits with is_builtin=true).
//
// The actual per-cluster install state lives in ClusterPlugin, which
// references this row via PluginID.
type Plugin struct {
	ID          uint           `gorm:"primaryKey;autoIncrement" json:"id"`
	Name        string         `gorm:"type:varchar(63);not null;uniqueIndex" json:"name"`         // DNS-compatible, used as CRD metadata.name
	DisplayName string         `gorm:"type:varchar(255);not null" json:"display_name"`
	// Length-capped to match the API validator + frontend textarea
	// maxLength. Stored as varchar(500) so direct DB writes can't
	// bypass the limit either; the card UI clamps display to 3 lines
	// regardless.
	Description string         `gorm:"type:varchar(500)" json:"description"`
	Category    PluginCategory `gorm:"type:varchar(32);not null;default:'custom'" json:"category"`
	IsBuiltin   bool           `gorm:"not null;default:false" json:"is_builtin"`
	IconURL     string         `gorm:"type:varchar(512)" json:"icon_url"`

	// SortOrder controls listing position WITHIN a category. Lower value
	// = earlier. Built-in plugins set this in seed.go to match the
	// logical "primary first, companions next" reading order; custom
	// plugins default to 0 (sort by name).
	SortOrder int `gorm:"not null;default:0" json:"sort_order"`

	ChartType ChartType `gorm:"type:varchar(16);not null" json:"chart_type"`

	// ChartType=repo
	ChartRepo string `gorm:"type:varchar(512)" json:"chart_repo"`
	ChartName string `gorm:"type:varchar(255)" json:"chart_name"`

	// ChartType=local — references the uploaded .tgz blob
	ChartBlobID *uint       `gorm:"index" json:"chart_blob_id,omitempty"`
	ChartBlob   *PluginBlob `gorm:"foreignKey:ChartBlobID" json:"-"`

	DefaultVersion          string `gorm:"type:varchar(64)" json:"default_version"`
	DefaultValues           string `gorm:"type:text" json:"default_values"`              // YAML
	DefaultReleaseNamespace string `gorm:"type:varchar(63);default:'kube-system'" json:"default_release_namespace"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// PluginBlob stores the raw .tgz bytes uploaded for a local chart. The
// sha256 is computed on upload and never changes — same content uploaded
// twice is deduped (handler reuses the existing blob row).
type PluginBlob struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Filename   string    `gorm:"type:varchar(255);not null" json:"filename"`
	Content    []byte    `gorm:"type:bytea;not null" json:"-"`
	SizeBytes  int64     `gorm:"not null" json:"size_bytes"`
	SHA256     string    `gorm:"type:varchar(64);not null;uniqueIndex" json:"sha256"`
	UploadedAt time.Time `json:"uploaded_at"`
}

// ClusterPlugin is the per-cluster install record. One row per
// (cluster_id, plugin_id) regardless of enable state — disabled state is
// kept as a row so we remember the user's last values_override.
type ClusterPlugin struct {
	ClusterID string `gorm:"primaryKey;type:varchar(36)" json:"cluster_id"`
	PluginID  uint   `gorm:"primaryKey" json:"plugin_id"`

	Enabled bool `gorm:"not null;default:false" json:"enabled"`

	// Per-cluster overrides on top of Plugin's defaults. Empty = use default.
	VersionOverride string `gorm:"type:varchar(64)" json:"version_override"`
	ValuesOverride  string `gorm:"type:text" json:"values_override"`

	// Status mirrored from PluginStatusPush
	Phase              PluginPhase `gorm:"type:varchar(20);not null;default:'Disabled'" json:"phase"`
	Message            string      `gorm:"type:text" json:"message"`
	ObservedVersion    string      `gorm:"type:varchar(64)" json:"observed_version"`
	ObservedValuesHash string      `gorm:"type:varchar(64)" json:"observed_values_hash"`
	HelmRevision       int32       `gorm:"default:0" json:"helm_revision"`
	InstalledAt        *time.Time  `json:"installed_at,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	Plugin *Plugin `gorm:"foreignKey:PluginID" json:"plugin,omitempty"`
}
