package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
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

// Field length caps mirror the DB column types and the frontend form
// maxLength props — three-layer defense so a hand-rolled API request
// can't sneak oversized text past us. ValuesLen is generous (64 KiB)
// because Helm values for complex charts can run 10+ KB; everything
// else matches the column varchar() exactly.
const (
	maxPluginNameLen        = 63 // DNS-1123 label
	maxPluginDisplayNameLen = 100
	maxPluginDescriptionLen = 500
	maxPluginIconURLLen     = 512
	maxPluginChartRepoLen   = 512
	maxPluginChartNameLen   = 200
	maxPluginVersionLen     = 64
	maxPluginNamespaceLen   = 63 // DNS-1123 label
	maxPluginValuesLen      = 64 * 1024
)

// validCategories is the closed set the FE Select restricts to. Mirror
// it server-side so a hand-rolled API call can't store an arbitrary
// string that would never group anywhere on the UI.
var validCategories = map[store.PluginCategory]bool{
	store.PluginCategoryGPU:        true,
	store.PluginCategoryScheduling: true,
	store.PluginCategoryNetworking: true,
	store.PluginCategoryStorage:    true,
	store.PluginCategoryMonitoring: true,
	store.PluginCategoryLogging:    true,
	store.PluginCategorySecurity:   true,
	store.PluginCategoryServing:    true,
	store.PluginCategoryCustom:     true,
}

// validate enforces shape + length invariants on the request. Returns
// a code suitable for apiErr; empty string means valid.
func (r *pluginRequest) validate() string {
	if len(r.Name) > maxPluginNameLen ||
		len(r.DisplayName) > maxPluginDisplayNameLen ||
		len(r.Description) > maxPluginDescriptionLen ||
		len(r.IconURL) > maxPluginIconURLLen ||
		len(r.ChartRepo) > maxPluginChartRepoLen ||
		len(r.ChartName) > maxPluginChartNameLen ||
		len(r.DefaultVersion) > maxPluginVersionLen ||
		len(r.DefaultReleaseNamespace) > maxPluginNamespaceLen ||
		len(r.DefaultValues) > maxPluginValuesLen {
		return CodeInvalidRequest
	}
	// Empty category is allowed — Create/Update default it to "custom".
	if r.Category != "" && !validCategories[r.Category] {
		return CodeInvalidRequest
	}
	switch r.ChartType {
	case store.ChartTypeRepo:
		if r.ChartRepo == "" || r.ChartName == "" {
			return CodePluginChartMissing
		}
	case store.ChartTypeOCI:
		// For OCI we expect a single complete URL; ChartName is unused
		// (OCI chart references don't split into repo + name).
		if r.ChartRepo == "" {
			return CodePluginChartMissing
		}
		if !strings.HasPrefix(r.ChartRepo, "oci://") {
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
	// In-use check is now inside the same transaction as the cascade
	// (see store.DeletePlugin). A racing EnablePlugin can't sneak a
	// new ClusterPlugin row in between check and delete.
	if err := store.DeletePlugin(id); err != nil {
		if errors.Is(err, store.ErrPluginInUse) {
			apiErr(c, http.StatusConflict, CodePluginInUse)
			return
		}
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

func (r *enableRequest) validate() string {
	if len(r.VersionOverride) > maxPluginVersionLen ||
		len(r.ValuesOverride) > maxPluginValuesLen ||
		len(r.ReleaseNamespaceOverride) > maxPluginNamespaceLen {
		return CodeInvalidRequest
	}
	return ""
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
		if code := req.validate(); code != "" {
			apiErr(c, http.StatusBadRequest, code)
			return
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

		// Pre-flight: bail out without touching the DB if the Worker
		// can't receive the command. Otherwise we'd flip the row to
		// Pending and leave it stuck (Worker has no idea it was
		// expected to act, no reconcile-on-reconnect yet).
		if _, ok := gw.GetWorker(clusterID); !ok {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}

		// Reject re-enable while a previous Disable is still being
		// processed. Without this, the SSA we're about to send would
		// land on a CRD that already has DeletionTimestamp set — Worker
		// would update the spec, but the finalizer-driven deletion still
		// runs and removes the CRD anyway. The new ClusterPlugin row
		// (enabled=true) then survives the Disabled push (its
		// enabled=false predicate doesn't match), leaving Phase=Pending
		// forever with no CRD on the cluster. User experience: re-click
		// Enable does nothing visible.
		//
		// `existing.Enabled == false` is the canonical "user already
		// asked for this gone" signal — the disable handler sets it
		// before sending the command. Surface a 409 so the UI can
		// explain "wait for uninstall to finish".
		if existing, err := store.GetClusterPlugin(clusterID, plugin.ID); err == nil {
			if !existing.Enabled {
				apiErr(c, http.StatusConflict, CodePluginUninstalling)
				return
			}
			// Release-namespace lock: Helm release identity is (name,
			// namespace), and our chart cache + reconciler track release
			// state by the new namespace only. Letting the user change
			// namespace after install would orphan the old release in
			// the previous namespace with no Helm-aware path to clean
			// it up. Refuse the change; the user can disable (which
			// uninstalls from the OLD namespace) and then re-enable in
			// the new one.
			if existing.HelmRevision > 0 {
				wantNS := req.ReleaseNamespaceOverride
				if wantNS == "" {
					wantNS = plugin.DefaultReleaseNamespace
				}
				haveNS := existing.ReleaseNamespaceOverride
				if haveNS == "" {
					haveNS = plugin.DefaultReleaseNamespace
				}
				if wantNS != haveNS {
					apiErr(c, http.StatusBadRequest, CodePluginNamespaceLock)
					return
				}
			}
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

		// Resolve the worker's reported cluster domain so buildEnableCommand
		// can substitute ${KPILOT_CLUSTER_DOMAIN} in YAML values (used by
		// charts that hard-code in-cluster Service URLs in their defaults,
		// e.g. Grafana's VictoriaMetrics datasource pre-provisioning).
		// We just confirmed the worker is connected above (pre-flight),
		// so the GetWorker lookup is safe to do without falling back.
		var workerDomain string
		if w, ok := gw.GetWorker(clusterID); ok {
			workerDomain = w.ClusterDomain
		}
		cmd, err := buildEnableCommand(plugin, cp, workerDomain)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		// Push first; only persist Pending if the Worker actually
		// accepted the command. SendPluginCommand returns an error if
		// the Worker disconnected between the pre-flight and now.
		if err := gw.SendPluginCommand(clusterID, cmd); err != nil {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		if err := store.UpsertClusterPlugin(cp); err != nil {
			apiErrInternal(c, err)
			return
		}
		// Drop any cached "namespace + Running" entry from the proxy
		// resolver so the new release namespace / phase takes effect on
		// the next proxied request, not after the 30s TTL expires.
		InvalidateProxyResolve(clusterID, plugin.Name)
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

		// Pre-flight: same reasoning as EnablePlugin — don't transition
		// the row to Uninstalling unless we know the Worker can act on it.
		if _, ok := gw.GetWorker(clusterID); !ok {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}

		cmd := &proto.PluginCommand{
			Action:  "disable",
			CrdName: plugin.Name,
		}
		// Push first; persist the new phase only after the Worker
		// accepted the command, so a failed push leaves the DB row
		// untouched.
		if err := gw.SendPluginCommand(clusterID, cmd); err != nil {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		if err := store.UpdateClusterPluginStatus(clusterID, plugin.ID, map[string]any{
			"enabled": false,
			"phase":   store.PluginPhaseUninstalling,
			"message": "",
		}); err != nil {
			apiErrInternal(c, err)
			return
		}
		// Cached "Running" entries would otherwise let the proxy keep
		// forwarding to a release that's about to be uninstalled.
		InvalidateProxyResolve(clusterID, plugin.Name)
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

// kpilotPlaceholderRE matches ${KPILOT_<NAME>} where <NAME> is one or more
// uppercase letters / digits / underscores. The narrow charset is on
// purpose — Helm values can carry literal `$` (templating, env-var refs);
// requiring the exact KPILOT_ prefix + caps avoids matching real Helm syntax.
var kpilotPlaceholderRE = regexp.MustCompile(`\$\{KPILOT_([A-Z0-9_]+)\}`)

// expandKPilotVars resolves every ${KPILOT_X} token in the values YAML
// against the provided variable map. Unknown tokens are left literal and
// logged once — silent leave-as-is matches shell behavior for undefined
// vars and keeps weird deploys from blowing up; the log line surfaces
// typos in the chart's default_values so they get noticed.
//
// Adding a new placeholder is one line in the caller's `vars` map — no
// need to add another ReplaceAll call here.
func expandKPilotVars(values string, vars map[string]string) string {
	return kpilotPlaceholderRE.ReplaceAllStringFunc(values, func(match string) string {
		name := kpilotPlaceholderRE.FindStringSubmatch(match)[1]
		if v, ok := vars[name]; ok {
			return v
		}
		log.Printf("[plugin] unknown placeholder ${KPILOT_%s} in values, left as-is", name)
		return match
	})
}

// buildEnableCommand merges registry defaults with per-cluster overrides
// and produces the on-the-wire PluginCommand. For local-chart plugins it
// also includes the .tgz blob bytes — the Worker writes them to its
// chart cache by sha256 so subsequent commands can omit `blob`.
//
// workerDomain is the cluster's K8s DNS suffix as reported on register
// (typically "cluster.local"); used to substitute ${KPILOT_CLUSTER_DOMAIN}
// in chart values. Empty string falls back to "cluster.local".
func buildEnableCommand(p *store.Plugin, cp *store.ClusterPlugin, workerDomain string) (*proto.PluginCommand, error) {
	values := cp.ValuesOverride
	if values == "" {
		values = p.DefaultValues
	}
	// Resolve well-known ${KPILOT_*} placeholders in the final values
	// payload before it leaves Server. To register a new variable: add
	// one entry to this map. The names are documented for chart authors:
	//
	//   CLUSTER_ID     — cluster UUID. Used by reverse-proxied plugins
	//                    (Grafana root_url, etc.) so generated links
	//                    route back through /proxy/<plugin>/.
	//   CLUSTER_DOMAIN — K8s DNS suffix reported by the worker. Used by
	//                    chart defaults that hard-code in-cluster Service
	//                    FQDNs. Falls back to "cluster.local" when the
	//                    worker registered without reporting it.
	//
	// Keep tokens ALL_CAPS_WITH_UNDERSCORES so they stay greppable and
	// match the regex's charset.
	if workerDomain == "" {
		workerDomain = "cluster.local"
	}
	values = expandKPilotVars(values, map[string]string{
		"CLUSTER_ID":     cp.ClusterID,
		"CLUSTER_DOMAIN": workerDomain,
	})
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
	case store.ChartTypeRepo, store.ChartTypeOCI:
		// OCI plugins reuse chart_repo for the full oci:// URL; the
		// worker reconciler dispatches on Type.
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
