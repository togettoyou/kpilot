package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

const maxChartUploadBytes = 16 << 20 // 16 MiB — Helm charts are typically <5 MiB

// ─── Registry: list / get / create / update / delete ───────────────────────

func ListPlugins(c *gin.Context) {
	plugins, err := store.ListPlugins()
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusOK, plugins)
}

func GetPlugin(c *gin.Context) {
	id, err := parsePluginID(c)
	if err != nil {
		return
	}
	p, err := store.GetPluginByID(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodePluginNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusOK, p)
}

type pluginRequest struct {
	Name                    string                `json:"name" binding:"required"`
	DisplayName             string                `json:"display_name" binding:"required"`
	Description             string                `json:"description"`
	Category                store.PluginCategory  `json:"category"`
	IconURL                 string                `json:"icon_url"`
	ChartType               store.ChartType       `json:"chart_type" binding:"required"`
	ChartRepo               string                `json:"chart_repo"`
	ChartName               string                `json:"chart_name"`
	ChartBlobID             *uint                 `json:"chart_blob_id"`
	DefaultVersion          string                `json:"default_version"`
	DefaultValues           string                `json:"default_values"`
	DefaultReleaseNamespace string                `json:"default_release_namespace"`
}

// validate enforces the chart-type-specific invariants. Returns a code
// suitable for apiErr (empty string means valid).
func (r *pluginRequest) validate() string {
	switch r.ChartType {
	case store.ChartTypeRepo:
		if r.ChartRepo == "" || r.ChartName == "" {
			return CodePluginChartMissing
		}
	case store.ChartTypeLocal:
		if r.ChartBlobID == nil {
			return CodePluginChartMissing
		}
	default:
		return CodeInvalidRequest
	}
	return ""
}

func CreatePlugin(c *gin.Context) {
	var req pluginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if code := req.validate(); code != "" {
		apiErr(c, http.StatusBadRequest, code)
		return
	}
	if !validateBlobRef(c, &req) {
		return
	}
	exists, err := store.PluginNameExists(req.Name)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	if exists {
		apiErr(c, http.StatusConflict, CodePluginNameExists)
		return
	}
	if req.Category == "" {
		req.Category = store.PluginCategoryCustom
	}
	if req.DefaultReleaseNamespace == "" {
		req.DefaultReleaseNamespace = "kube-system"
	}
	now := time.Now()
	p := &store.Plugin{
		Name:                    req.Name,
		DisplayName:             req.DisplayName,
		Description:             req.Description,
		Category:                req.Category,
		IsBuiltin:               false,
		IconURL:                 req.IconURL,
		ChartType:               req.ChartType,
		ChartRepo:               req.ChartRepo,
		ChartName:               req.ChartName,
		ChartBlobID:             req.ChartBlobID,
		DefaultVersion:          req.DefaultVersion,
		DefaultValues:           req.DefaultValues,
		DefaultReleaseNamespace: req.DefaultReleaseNamespace,
		CreatedAt:               now,
		UpdatedAt:               now,
	}
	if err := store.CreatePlugin(p); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusCreated, p)
}

func UpdatePlugin(c *gin.Context) {
	id, err := parsePluginID(c)
	if err != nil {
		return
	}
	existing, err := store.GetPluginByID(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodePluginNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}
	if existing.IsBuiltin {
		apiErr(c, http.StatusForbidden, CodePluginBuiltinLocked)
		return
	}
	var req pluginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if code := req.validate(); code != "" {
		apiErr(c, http.StatusBadRequest, code)
		return
	}
	if !validateBlobRef(c, &req) {
		return
	}
	if req.Name != existing.Name {
		exists, err := store.PluginNameExists(req.Name)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		if exists {
			apiErr(c, http.StatusConflict, CodePluginNameExists)
			return
		}
	}
	if req.Category == "" {
		req.Category = store.PluginCategoryCustom
	}
	if req.DefaultReleaseNamespace == "" {
		req.DefaultReleaseNamespace = "kube-system"
	}
	updates := map[string]any{
		"name":                      req.Name,
		"display_name":              req.DisplayName,
		"description":               req.Description,
		"category":                  req.Category,
		"icon_url":                  req.IconURL,
		"chart_type":                req.ChartType,
		"chart_repo":                req.ChartRepo,
		"chart_name":                req.ChartName,
		"chart_blob_id":             req.ChartBlobID,
		"default_version":           req.DefaultVersion,
		"default_values":            req.DefaultValues,
		"default_release_namespace": req.DefaultReleaseNamespace,
	}
	if err := store.UpdatePlugin(id, updates); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func DeletePlugin(c *gin.Context) {
	id, err := parsePluginID(c)
	if err != nil {
		return
	}
	existing, err := store.GetPluginByID(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodePluginNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}
	if existing.IsBuiltin {
		apiErr(c, http.StatusForbidden, CodePluginBuiltinLocked)
		return
	}
	if err := store.DeletePlugin(id); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// UploadPluginChart accepts a multipart .tgz upload, computes its sha256,
// and dedupes against existing PluginBlob rows. Returns blob_id + sha256
// so the frontend can use them in a follow-up CreatePlugin call.
func UploadPluginChart(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxChartUploadBytes)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		// http.MaxBytesError is the typed sentinel; fall back to text match
		// for older runtimes that didn't expose it.
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			apiErr(c, http.StatusRequestEntityTooLarge, CodePluginUploadTooLarge)
			return
		}
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	defer file.Close()

	content, err := io.ReadAll(file)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	// Reject obviously-not-gzip payloads early — Helm chart .tgz must start
	// with the gzip magic number 1f 8b. The reconciler would catch this
	// later via loader.Load, but failing at upload time gives a synchronous
	// error code instead of a delayed Failed phase.
	if len(content) < 2 || content[0] != 0x1f || content[1] != 0x8b {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	digest := sha256.Sum256(content)
	blob := &store.PluginBlob{
		Filename:  header.Filename,
		Content:   content,
		SizeBytes: int64(len(content)),
		SHA256:    hex.EncodeToString(digest[:]),
	}
	if err := store.UpsertPluginBlob(blob); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id":         blob.ID,
		"sha256":     blob.SHA256,
		"size_bytes": blob.SizeBytes,
		"filename":   blob.Filename,
	})
}

// ─── Per-cluster: list + enable/disable ────────────────────────────────────

// ListClusterPlugins joins the registry with the per-cluster install state
// so the UI can render a single grid: every registry plugin shows up, and
// those installed on this cluster carry their phase + values.
type clusterPluginItem struct {
	Plugin            *store.Plugin    `json:"plugin"`
	Enabled           bool             `json:"enabled"`
	Phase             store.PluginPhase `json:"phase"`
	Message           string           `json:"message,omitempty"`
	ObservedVersion   string           `json:"observed_version,omitempty"`
	HelmRevision      int32            `json:"helm_revision,omitempty"`
	InstalledAt       *time.Time       `json:"installed_at,omitempty"`
	VersionOverride   string           `json:"version_override,omitempty"`
	ValuesOverride    string           `json:"values_override,omitempty"`
	NamespaceOverride string           `json:"release_namespace_override,omitempty"`
}

func ListClusterPlugins(c *gin.Context) {
	clusterID := c.Param("id")
	if _, err := store.GetClusterByID(clusterID); err != nil {
		apiErr(c, http.StatusNotFound, CodeClusterNotFound)
		return
	}
	plugins, err := store.ListPlugins()
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	rows, err := store.ListClusterPlugins(clusterID)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	byPlugin := make(map[uint]store.ClusterPlugin, len(rows))
	for _, r := range rows {
		byPlugin[r.PluginID] = r
	}
	out := make([]clusterPluginItem, 0, len(plugins))
	for i := range plugins {
		p := &plugins[i]
		item := clusterPluginItem{Plugin: p, Phase: store.PluginPhaseDisabled}
		if cp, ok := byPlugin[p.ID]; ok {
			item.Enabled = cp.Enabled
			item.Phase = cp.Phase
			item.Message = cp.Message
			item.ObservedVersion = cp.ObservedVersion
			item.HelmRevision = cp.HelmRevision
			item.InstalledAt = cp.InstalledAt
			item.VersionOverride = cp.VersionOverride
			item.ValuesOverride = cp.ValuesOverride
			item.NamespaceOverride = cp.ReleaseNamespaceOverride
		}
		out = append(out, item)
	}
	c.JSON(http.StatusOK, out)
}

type enableRequest struct {
	VersionOverride          string `json:"version_override"`
	ValuesOverride           string `json:"values_override"`
	ReleaseNamespaceOverride string `json:"release_namespace_override"`
}

// EnablePlugin saves the per-cluster overrides, marks the row as enabled,
// builds a PluginCommand by merging registry defaults + overrides, and
// pushes it to the Worker. The Worker reports back asynchronously via
// PluginStatusPush.
func EnablePlugin(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		pluginName := c.Param("name")
		var req enableRequest
		// Empty body is fine — defaults apply. Only call ShouldBindJSON
		// when there's actually a payload to parse, which sidesteps the
		// fragility of comparing the parser error against io.EOF.
		if c.Request.ContentLength != 0 {
			if err := c.ShouldBindJSON(&req); err != nil {
				apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
				return
			}
		}
		if _, err := store.GetClusterByID(clusterID); err != nil {
			apiErr(c, http.StatusNotFound, CodeClusterNotFound)
			return
		}
		plugin, err := store.GetPluginByName(pluginName)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				apiErr(c, http.StatusNotFound, CodePluginNotFound)
				return
			}
			apiErrInternal(c, err)
			return
		}

		cp := &store.ClusterPlugin{
			ClusterID:                clusterID,
			PluginID:                 plugin.ID,
			Enabled:                  true,
			VersionOverride:          req.VersionOverride,
			ValuesOverride:           req.ValuesOverride,
			ReleaseNamespaceOverride: req.ReleaseNamespaceOverride,
			Phase:                    store.PluginPhasePending,
		}
		if err := store.UpsertClusterPlugin(cp); err != nil {
			apiErrInternal(c, err)
			return
		}

		cmd, err := buildEnableCommand(plugin, cp)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		if err := gw.SendPluginCommand(clusterID, cmd); err != nil {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		c.Status(http.StatusAccepted)
	}
}

func DisablePlugin(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		pluginName := c.Param("name")

		if _, err := store.GetClusterByID(clusterID); err != nil {
			apiErr(c, http.StatusNotFound, CodeClusterNotFound)
			return
		}
		plugin, err := store.GetPluginByName(pluginName)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				apiErr(c, http.StatusNotFound, CodePluginNotFound)
				return
			}
			apiErrInternal(c, err)
			return
		}
		// The per-cluster row must exist (created by EnablePlugin); without
		// it there's no Helm release to remove. Surface this as 404 instead
		// of silently sending a delete to a Worker that will no-op.
		if _, err := store.GetClusterPlugin(clusterID, plugin.ID); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				apiErr(c, http.StatusNotFound, CodePluginNotFound)
				return
			}
			apiErrInternal(c, err)
			return
		}

		// Mark Enabled=false + Phase=Uninstalling so the UI shows progress
		// immediately. PluginStatusPush from the Worker will move it to
		// Disabled (or Failed) when uninstall completes.
		if err := store.UpdateClusterPluginStatus(clusterID, plugin.ID, map[string]any{
			"enabled": false,
			"phase":   store.PluginPhaseUninstalling,
			"message": "",
		}); err != nil {
			apiErrInternal(c, err)
			return
		}

		cmd := &proto.PluginCommand{
			Action:  "disable",
			CrdName: plugin.Name,
		}
		if err := gw.SendPluginCommand(clusterID, cmd); err != nil {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		c.Status(http.StatusAccepted)
	}
}

// ─── helpers ────────────────────────────────────────────────────────────────

// validateBlobRef ensures a chart_blob_id present in the request actually
// corresponds to a stored blob. Without this we'd accept any uint and the
// reconciler would surface the dangling reference as Failed at install
// time — the API should reject up-front instead. Writes the response on
// failure and returns false.
func validateBlobRef(c *gin.Context, req *pluginRequest) bool {
	if req.ChartType != store.ChartTypeLocal || req.ChartBlobID == nil {
		return true
	}
	if _, err := store.GetPluginBlobByID(*req.ChartBlobID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusBadRequest, CodePluginChartMissing)
		} else {
			apiErrInternal(c, err)
		}
		return false
	}
	return true
}

func parsePluginID(c *gin.Context) (uint, error) {
	raw := c.Param("id")
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return 0, err
	}
	return uint(v), nil
}

// buildEnableCommand merges registry defaults with per-cluster overrides
// and produces the on-the-wire PluginCommand. For local-chart plugins it
// also includes the .tgz blob bytes — the Worker writes them to its
// chart cache by sha256 so subsequent commands can omit `blob`.
func buildEnableCommand(p *store.Plugin, cp *store.ClusterPlugin) (*proto.PluginCommand, error) {
	values := cp.ValuesOverride
	if values == "" {
		values = p.DefaultValues
	}
	version := cp.VersionOverride
	if version == "" {
		version = p.DefaultVersion
	}
	releaseNS := cp.ReleaseNamespaceOverride
	if releaseNS == "" {
		releaseNS = p.DefaultReleaseNamespace
	}

	chart := &proto.ChartSource{
		Type:    string(p.ChartType),
		Name:    p.ChartName,
		Version: version,
	}
	switch p.ChartType {
	case store.ChartTypeRepo:
		chart.Repo = p.ChartRepo
	case store.ChartTypeLocal:
		if p.ChartBlobID == nil {
			return nil, errors.New("local chart has no blob")
		}
		blob, err := store.GetPluginBlobByID(*p.ChartBlobID)
		if err != nil {
			return nil, err
		}
		chart.Sha256 = blob.SHA256
		chart.Blob = blob.Content
	}

	return &proto.PluginCommand{
		Action:  "enable",
		CrdName: p.Name,
		Spec: &proto.PluginSpec{
			PluginId:         strconv.FormatUint(uint64(p.ID), 10),
			DisplayName:      p.DisplayName,
			Chart:            chart,
			ReleaseName:      p.Name, // Helm release name = plugin name (one per cluster)
			ReleaseNamespace: releaseNS,
			Values:           values,
		},
	}, nil
}
