package plugin

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/cli"
	"helm.sh/helm/v3/pkg/registry"
	"helm.sh/helm/v3/pkg/release"
	"helm.sh/helm/v3/pkg/storage/driver"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/yaml"
)

// helmInstallTimeout caps how long Helm waits for resources to become
// Ready before declaring failure. Big images on a first-time pull
// (VictoriaMetrics, Volcano scheduler / vGPU device plugin at
// hundreds of MB) routinely take 5+ minutes from a cold cache or a
// slow registry; 10 minutes leaves room for that without leaving
// truly wedged installs hanging indefinitely.
const helmInstallTimeout = 10 * time.Minute

// HelmDriver is the storage backend Helm uses for release state. "secrets"
// stores release state as Kubernetes Secrets (the Helm v3 default).
const HelmDriver = "secrets"

// HelmRunner wraps the Helm v3 SDK for the operations the reconciler needs.
// One instance per Worker process — action.Configuration is built per-call
// because release namespaces vary per Plugin. The registry client is shared
// across all calls (it carries the OCI auth state Helm 3.8+ needs).
type HelmRunner struct {
	cfg            *rest.Config
	settings       *cli.EnvSettings
	registryClient *registry.Client
}

func NewHelmRunner(cfg *rest.Config, dataDir string) *HelmRunner {
	// Helm has TWO independent ways to find its state, and we need to
	// satisfy both:
	//
	// 1. cli.EnvSettings struct fields (RepositoryConfig, RepositoryCache,
	//    etc.) — read by action.Pull / Install when it cares to look.
	// 2. helmpath.* package-level globals — read by repo.NewChartRepository
	//    which Pull calls INTERNALLY for `--repo` URL resolution and which
	//    silently IGNORES the struct fields. These resolve from env vars
	//    in this order: HELM_*_HOME → XDG_CACHE_HOME/HOME → os.UserCacheDir().
	//
	// On a distroless nonroot image with readOnlyRootFilesystem, the
	// default os.UserCacheDir() resolves to `/home/nonroot/.cache` which
	// doesn't exist and can't be created. Result: `helm pull --repo`
	// fails on the very first chart with
	//   "looks like <repo> is not a valid chart repository:
	//    open /home/nonroot/.cache/helm/repository/<hash>-index.yaml:
	//    no such file or directory"
	// (OCI pulls are unaffected because they bypass repo index entirely.)
	//
	// Fix: export HELM_CACHE_HOME / HELM_CONFIG_HOME / HELM_DATA_HOME
	// pointing under DataDir BEFORE calling cli.New(), so both paths
	// agree and both resolve to our writable PVC mount.
	if dataDir != "" {
		helmHome := filepath.Join(dataDir, "helm")
		cacheHome := filepath.Join(helmHome, "cache")
		configHome := filepath.Join(helmHome, "config")
		dataHome := filepath.Join(helmHome, "data")
		if os.Getenv("HELM_CACHE_HOME") == "" {
			_ = os.Setenv("HELM_CACHE_HOME", cacheHome)
		}
		if os.Getenv("HELM_CONFIG_HOME") == "" {
			_ = os.Setenv("HELM_CONFIG_HOME", configHome)
		}
		if os.Getenv("HELM_DATA_HOME") == "" {
			_ = os.Setenv("HELM_DATA_HOME", dataHome)
		}
		// Pre-create the subdirs Helm assumes exist. NewChartRepository
		// will fail to write a fresh index.yaml into a non-existent
		// directory — Helm only creates the parent on `helm repo add`,
		// not on the implicit add that Pull does for `--repo` URLs.
		// MkdirAll is best-effort: dev machines without write access
		// surface EACCES at install time, where it's actionable.
		_ = os.MkdirAll(filepath.Join(cacheHome, "repository"), 0o755)
		_ = os.MkdirAll(configHome, 0o755)
		_ = os.MkdirAll(dataHome, 0o755)
	}
	settings := cli.New()
	// Belt-and-suspenders: even with the env vars set, an operator-
	// supplied HELM_REPOSITORY_CONFIG / HELM_REPOSITORY_CACHE wins
	// because cli.New() honors them directly. cli.New() already wired
	// them via the env above when those weren't set; nothing else to
	// do here.
	// One registry client process-wide. Helm's OCI flow requires this on
	// action.Configuration; without it, action.Install of an oci:// chart
	// returns "registry client is not initialized". We only support
	// anonymous pulls right now — public registries (docker.io, quay.io,
	// ghcr.io public namespaces). Private registry auth would attach
	// credentials here and call rc.Login per-host.
	rc, err := registry.NewClient()
	if err != nil {
		// Degrade gracefully: OCI plugins will fail at install time with
		// a clear message, but non-OCI plugins keep working.
		log.Printf("[plugin-helm] registry client init failed: %v (OCI charts will fail until restart)", err)
	}
	return &HelmRunner{cfg: cfg, settings: settings, registryClient: rc}
}

// Logger is the per-action progress sink shape Helm SDK expects. Used
// by reconciler to capture install / upgrade / uninstall progress and
// forward it to the per-(cluster, plugin) log stream for the UI to
// render. Nil = fall back to stdout (helmLogf below).
type Logger func(format string, args ...interface{})

// newConfiguration builds an action.Configuration scoped to the given
// release namespace. Helm's release storage uses one Secret per release
// in that namespace, so the namespace must match what's used for both
// install and uninstall (otherwise uninstall can't find the release).
//
// The logger is what Helm calls with progress lines like "creating x
// resource(s) for resource", "beginning wait", "Patch X in namespace
// Y" — feeding it back into the reconciler lets us stream those to
// the UI in real time.
func (h *HelmRunner) newConfiguration(namespace string, logger Logger) (*action.Configuration, error) {
	if logger == nil {
		logger = helmLogf
	}
	getter := newRESTClientGetter(h.cfg, namespace)
	cfg := new(action.Configuration)
	if err := cfg.Init(getter, namespace, HelmDriver, action.DebugLog(logger)); err != nil {
		return nil, fmt.Errorf("init helm config: %w", err)
	}
	// Required for OCI charts. Set even when this install is non-OCI —
	// it's a no-op for traditional repo charts and the cost is one
	// pointer assignment.
	cfg.RegistryClient = h.registryClient
	return cfg, nil
}

// helmLogf is the fallback progress sink when no per-install logger is
// supplied (e.g. boot-time chart loads). Forwards to the standard log
// package so reconcile output sits next to everything else.
func helmLogf(format string, args ...interface{}) {
	log.Printf("[plugin-helm] "+format, args...)
}

// ChartRef tells LoadChart how to resolve the Helm chart. Exactly one of
// the source fields is populated:
//   - LocalPath: ChartType=local, points at a cached .tgz on disk
//   - OCIRef: ChartType=oci, full `oci://host/path/chart` URL
//   - RepoURL + Name: ChartType=repo, traditional Helm chart repo
type ChartRef struct {
	LocalPath string // ChartType=local
	OCIRef    string // ChartType=oci  (e.g. oci://ghcr.io/grafana-community/helm-charts/grafana)
	RepoURL   string // ChartType=repo (e.g. https://volcano-sh.github.io/helm-charts)
	Name      string // ChartType=repo only — chart name within the repo
	Version   string
}

func (h *HelmRunner) LoadChart(ref ChartRef) (*chart.Chart, error) {
	if ref.LocalPath != "" {
		return loader.Load(ref.LocalPath)
	}
	if ref.OCIRef != "" {
		return h.loadOCI(ref)
	}
	return h.loadRepo(ref)
}

// loadOCI pulls an OCI artifact (Helm 3.8+). The full oci:// URL goes in
// as the chart argument to Pull — there's no separate "repo" / "name"
// split for OCI references like there is for traditional repos.
//
// Cache layout: oci pulls land in RepositoryCache as <chart>-<version>.tgz
// where <chart> is the last path segment of the OCI ref (e.g.
// "gateway-helm" for oci://docker.io/envoyproxy/gateway-helm). Pull
// writes the file as `<inferred-name>-<version>.tgz`, same as the repo
// flow, so the cache lookup is symmetric.
func (h *HelmRunner) loadOCI(ref ChartRef) (*chart.Chart, error) {
	if h.registryClient == nil {
		return nil, fmt.Errorf("registry client unavailable; restart worker")
	}
	// Cache hit shortcut for pinned versions. The cache file is named
	// after the last path segment because that's how Helm's Pull writes
	// it. Same digit-prefix heuristic as loadRepo prevents prefix
	// collisions (e.g. "gateway-helm" matching "gateway-helm-extras").
	chartName := ociChartName(ref.OCIRef)
	if ref.Version != "" && chartName != "" {
		cached := filepath.Join(
			h.settings.RepositoryCache,
			fmt.Sprintf("%s-%s.tgz", chartName, ref.Version),
		)
		if _, err := os.Stat(cached); err == nil {
			return loader.Load(cached)
		}
	}
	cfg := &action.Configuration{RegistryClient: h.registryClient}
	pull := action.NewPullWithOpts(action.WithConfig(cfg))
	pull.Settings = h.settings
	// Crucially: don't set RepoURL for OCI — the full URL IS the chart
	// argument. Setting RepoURL would make Helm try to interpret it as
	// an HTTPS repo and fail with "looks like ... is not a valid repo".
	pull.Version = ref.Version
	pull.DestDir = h.settings.RepositoryCache
	pull.Untar = false
	if _, err := pull.Run(ref.OCIRef); err != nil {
		return nil, fmt.Errorf("pull oci chart: %w", err)
	}
	if ref.Version != "" && chartName != "" {
		exact := filepath.Join(pull.DestDir, fmt.Sprintf("%s-%s.tgz", chartName, ref.Version))
		if _, err := os.Stat(exact); err == nil {
			return loader.Load(exact)
		}
	}
	// Fallback: glob by inferred chart name. If the inferred name is
	// empty (malformed OCI ref) glob falls through to "*.tgz" — too
	// promiscuous, so refuse instead.
	if chartName == "" {
		return nil, fmt.Errorf("could not infer chart name from %q", ref.OCIRef)
	}
	matches, err := filepath.Glob(filepath.Join(pull.DestDir, chartName+"-*.tgz"))
	if err != nil || len(matches) == 0 {
		return nil, fmt.Errorf("pulled oci chart not found: %v", err)
	}
	target := matches[0]
	for _, m := range matches[1:] {
		ai, _ := os.Stat(target)
		bi, _ := os.Stat(m)
		if ai != nil && bi != nil && bi.ModTime().After(ai.ModTime()) {
			target = m
		}
	}
	return loader.Load(target)
}

// loadRepo handles traditional HTTPS Helm repos (those with index.yaml).
// Split out from LoadChart now that OCI is also a code path; behavior
// is unchanged from the prior single-method implementation.
func (h *HelmRunner) loadRepo(ref ChartRef) (*chart.Chart, error) {
	// Cache hit: when the user pinned a specific version we can skip the
	// network round-trip if the .tgz is already on disk. action.NewPull
	// in v3 always re-downloads even if RepositoryCache is set, so this
	// guard is what actually keeps reconcile retries off the network.
	if ref.Version != "" {
		cached := filepath.Join(
			h.settings.RepositoryCache,
			fmt.Sprintf("%s-%s.tgz", ref.Name, ref.Version),
		)
		if _, err := os.Stat(cached); err == nil {
			return loader.Load(cached)
		}
	}
	pull := action.NewPullWithOpts(action.WithConfig(&action.Configuration{}))
	pull.Settings = h.settings
	pull.RepoURL = ref.RepoURL
	pull.Version = ref.Version
	pull.DestDir = h.settings.RepositoryCache
	pull.Untar = false
	if _, err := pull.Run(ref.Name); err != nil {
		return nil, fmt.Errorf("pull chart: %w", err)
	}
	// Prefer exact-version filename when we have one — otherwise the
	// glob below would match charts that share a name prefix (e.g.
	// ref.Name="victoria-metrics" globs "victoria-metrics-single-*.tgz"
	// too) and a stray cached residual could win the most-recent-ModTime
	// tiebreaker.
	if ref.Version != "" {
		exact := filepath.Join(pull.DestDir, fmt.Sprintf("%s-%s.tgz", ref.Name, ref.Version))
		if _, err := os.Stat(exact); err == nil {
			return loader.Load(exact)
		}
	}
	matches, err := filepath.Glob(filepath.Join(pull.DestDir, ref.Name+"-*.tgz"))
	if err != nil || len(matches) == 0 {
		return nil, fmt.Errorf("pulled chart not found: %v", err)
	}
	// Filter out matches that share only the prefix — a chart named
	// `ref.Name-X` where X starts with non-digit isn't ours. Heuristic:
	// the segment after the dash should start with a digit (semver) or
	// be a plain version-like token. Best-effort; falls back to glob
	// behavior if nothing matches the heuristic.
	filtered := matches[:0]
	prefix := ref.Name + "-"
	for _, m := range matches {
		base := filepath.Base(m)
		rest := base[len(prefix) : len(base)-len(".tgz")]
		if len(rest) > 0 && (rest[0] >= '0' && rest[0] <= '9' || rest[0] == 'v') {
			filtered = append(filtered, m)
		}
	}
	if len(filtered) > 0 {
		matches = filtered
	}
	target := matches[0]
	for _, m := range matches[1:] {
		ai, _ := os.Stat(target)
		bi, _ := os.Stat(m)
		if ai != nil && bi != nil && bi.ModTime().After(ai.ModTime()) {
			target = m
		}
	}
	return loader.Load(target)
}

// ociChartName extracts the last path segment of an OCI chart ref. Helm
// uses this segment as the cache filename prefix — `helm pull
// oci://docker.io/envoyproxy/gateway-helm --version v1.7.2` writes
// "gateway-helm-v1.7.2.tgz". Returns "" for inputs that don't look
// well-formed.
func ociChartName(ociRef string) string {
	s := strings.TrimPrefix(ociRef, "oci://")
	if s == ociRef { // didn't have the prefix
		return ""
	}
	// Discard any tag (...:v1.0) or digest (...@sha256:...) — Helm uses
	// --version, but defensive in case a future input format includes them.
	if i := strings.IndexAny(s, ":@"); i >= 0 {
		s = s[:i]
	}
	// Trim trailing slash, then take everything after the last slash.
	s = strings.TrimRight(s, "/")
	if i := strings.LastIndex(s, "/"); i >= 0 {
		return s[i+1:]
	}
	return s
}


// ParseValues parses a YAML string into the map shape Helm expects.
// Empty input returns an empty map (Helm handles that fine).
func ParseValues(yamlText string) (map[string]any, error) {
	if yamlText == "" {
		return map[string]any{}, nil
	}
	out := map[string]any{}
	if err := yaml.Unmarshal([]byte(yamlText), &out); err != nil {
		return nil, fmt.Errorf("parse values: %w", err)
	}
	return out, nil
}

// InstallOrUpgrade installs the release if it doesn't exist yet, otherwise
// upgrades. Both code paths go through Helm SDK action types so behavior
// matches `helm install` / `helm upgrade` from the CLI exactly.
//
// Recovery note: if the Worker process gets SIGKILLed mid-install,
// Helm leaves the release in pending-install / pending-upgrade and a
// subsequent Upgrade refuses with "another operation in progress".
// We don't actively un-stick it here because disable+re-enable
// already handles it: Helm.Uninstall accepts releases in any state
// (pending included), and the reconciler's deletion path runs ahead
// of the AttemptHash gate, so the user just clicks Disable then
// Enable. If we ever see this happening enough to need automation,
// add a NewGet → status check → NewRollback(0) / NewUninstall before
// the install/upgrade dispatch below.
func (h *HelmRunner) InstallOrUpgrade(
	releaseName, namespace string,
	chart *chart.Chart,
	values map[string]any,
	logger Logger,
) (*release.Release, error) {
	cfg, err := h.newConfiguration(namespace, logger)
	if err != nil {
		return nil, err
	}

	// Check existing release. action.Get returns ErrReleaseNotFound when
	// nothing's there yet; we use that to choose install vs upgrade.
	get := action.NewGet(cfg)
	if existing, err := get.Run(releaseName); err == nil && existing != nil {
		up := action.NewUpgrade(cfg)
		up.Namespace = namespace
		up.Force = false
		up.MaxHistory = 5 // keep release history bounded
		// Wait until rolled-out resources report Ready before returning.
		// Critical for umbrella charts where later resources depend on
		// an earlier operator coming up (e.g. victoria-metrics-k8s-stack
		// patches CRs through a webhook served by the operator pod).
		up.Wait = true
		up.WaitForJobs = true
		up.Timeout = helmInstallTimeout
		// Atomic upgrades roll back to the previous good release if
		// anything fails — leaves the cluster in a consistent state
		// instead of half-applied with orphan webhook configs.
		up.Atomic = true
		return up.Run(releaseName, chart, values)
	}

	inst := action.NewInstall(cfg)
	inst.ReleaseName = releaseName
	inst.Namespace = namespace
	inst.CreateNamespace = true
	inst.Wait = true
	inst.WaitForJobs = true
	inst.Timeout = helmInstallTimeout
	// Atomic install rolls everything back on failure; without it the
	// cluster ends up with half-installed manifests that block retries
	// (orphan webhooks, dangling secrets, etc.).
	inst.Atomic = true
	return inst.Run(chart, values)
}

// Uninstall removes the release. If the release doesn't exist, returns nil
// (idempotent; matches `helm uninstall --wait` behavior with no release).
//
// Defensive probe: action.Uninstall on a release that was manually removed
// behaves in two distinct ways depending on how the manual removal was
// done. Plain `helm uninstall <r>` deletes every history Secret — the
// next Uninstall hits driver.ErrReleaseNotFound (wrapped) and we map it
// to nil via isReleaseNotFound. But `helm uninstall <r> --keep-history`
// (and a handful of "release in pending-uninstall / superseded state"
// scenarios) leave a history Secret whose status is StatusUninstalled;
// action.Uninstall then returns errors.Errorf("the release named %q is
// already uninstalled", ...) — a plain string error that does NOT wrap
// driver.ErrReleaseNotFound. Treating that as a real failure flips
// the reconciler into Failed → markFailed → 30s requeue → Uninstalling
// → markFailed loop, which combined with the Server's
// PersistClusterPluginStatusIfActive predicate filter on Failed-during-
// disable manifests as "stuck on Uninstalling forever" in the UI.
//
// We probe with action.Get first and short-circuit when the release is
// effectively absent (truly missing, or already in StatusUninstalled).
func (h *HelmRunner) Uninstall(releaseName, namespace string, logger Logger) error {
	cfg, err := h.newConfiguration(namespace, logger)
	if err != nil {
		return err
	}
	if rel, getErr := action.NewGet(cfg).Run(releaseName); getErr != nil {
		if isReleaseNotFound(getErr) {
			return nil
		}
		return fmt.Errorf("probe release: %w", getErr)
	} else if rel != nil && rel.Info != nil && rel.Info.Status == release.StatusUninstalled {
		return nil
	}
	uninst := action.NewUninstall(cfg)
	if _, err := uninst.Run(releaseName); err != nil {
		if isReleaseNotFound(err) {
			return nil
		}
		return fmt.Errorf("uninstall: %w", err)
	}
	return nil
}

// Get returns the latest release info, or nil if not installed.
func (h *HelmRunner) Get(releaseName, namespace string) (*release.Release, error) {
	cfg, err := h.newConfiguration(namespace, nil)
	if err != nil {
		return nil, err
	}
	rel, err := action.NewGet(cfg).Run(releaseName)
	if err != nil {
		if isReleaseNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return rel, nil
}

func isReleaseNotFound(err error) bool {
	return errors.Is(err, driver.ErrReleaseNotFound)
}
