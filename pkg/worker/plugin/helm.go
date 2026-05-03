package plugin

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/cli"
	"helm.sh/helm/v3/pkg/release"
	"helm.sh/helm/v3/pkg/repo"
	"helm.sh/helm/v3/pkg/storage/driver"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/yaml"
)

// helmInstallTimeout caps how long Helm waits for resources to become
// Ready before declaring failure. Long enough for operator-style
// charts that pull big images on first install (VictoriaMetrics
// stack, HAMi), short enough that a wedged install gets visible.
const helmInstallTimeout = 5 * time.Minute

// HelmDriver is the storage backend Helm uses for release state. "secrets"
// stores release state as Kubernetes Secrets (the Helm v3 default).
const HelmDriver = "secrets"

// HelmRunner wraps the Helm v3 SDK for the operations the reconciler needs.
// One instance per Worker process — action.Configuration is built per-call
// because release namespaces vary per Plugin.
type HelmRunner struct {
	cfg      *rest.Config
	settings *cli.EnvSettings
}

func NewHelmRunner(cfg *rest.Config) *HelmRunner {
	settings := cli.New()
	// Point Helm's repo cache at a writable directory. Defaults are under
	// $HOME which doesn't exist (or isn't writable) in many container
	// images; making this explicit avoids surprise EACCES errors.
	if settings.RepositoryConfig == "" || filepath.IsAbs(settings.RepositoryConfig) == false {
		settings.RepositoryConfig = "/var/lib/kpilot/helm/repositories.yaml"
	}
	if settings.RepositoryCache == "" {
		settings.RepositoryCache = "/var/lib/kpilot/helm/cache"
	}
	_ = os.MkdirAll(filepath.Dir(settings.RepositoryConfig), 0o755)
	_ = os.MkdirAll(settings.RepositoryCache, 0o755)
	return &HelmRunner{cfg: cfg, settings: settings}
}

// newConfiguration builds an action.Configuration scoped to the given
// release namespace. Helm's release storage uses one Secret per release
// in that namespace, so the namespace must match what's used for both
// install and uninstall (otherwise uninstall can't find the release).
func (h *HelmRunner) newConfiguration(namespace string) (*action.Configuration, error) {
	getter := newRESTClientGetter(h.cfg, namespace)
	cfg := new(action.Configuration)
	if err := cfg.Init(getter, namespace, HelmDriver, helmLogf); err != nil {
		return nil, fmt.Errorf("init helm config: %w", err)
	}
	return cfg, nil
}

// helmLogf is the per-action progress sink. We forward to the standard
// log package so reconcile output sits next to everything else.
func helmLogf(format string, args ...interface{}) {
	log.Printf("[plugin-helm] "+format, args...)
}

// LoadChart resolves a chart reference. For local charts the path is the
// cached .tgz; for repo charts we fetch via the chart-repo URL.
//
// repoURL is e.g. "https://project-hami.github.io/HAMi/", chartName is
// "hami". version may be empty (resolves to latest).
type ChartRef struct {
	LocalPath string // populated for ChartType=local
	RepoURL   string // populated for ChartType=repo
	Name      string
	Version   string
}

func (h *HelmRunner) LoadChart(ref ChartRef) (*chart.Chart, error) {
	if ref.LocalPath != "" {
		return loader.Load(ref.LocalPath)
	}
	// Repo flow: ResolveChart returns a downloaded .tgz path; loader.Load
	// then opens it.
	pull := action.NewPullWithOpts(action.WithConfig(&action.Configuration{}))
	pull.Settings = h.settings
	pull.RepoURL = ref.RepoURL
	pull.Version = ref.Version
	pull.DestDir = h.settings.RepositoryCache
	pull.Untar = false
	if _, err := pull.Run(ref.Name); err != nil {
		return nil, fmt.Errorf("pull chart: %w", err)
	}
	// Pull writes the .tgz to DestDir; pick it up by name+version.
	matches, err := filepath.Glob(filepath.Join(pull.DestDir, ref.Name+"-*.tgz"))
	if err != nil || len(matches) == 0 {
		return nil, fmt.Errorf("pulled chart not found: %v", err)
	}
	// Take the most recent match in case multiple versions are cached.
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
func (h *HelmRunner) InstallOrUpgrade(
	releaseName, namespace string,
	chart *chart.Chart,
	values map[string]any,
) (*release.Release, error) {
	cfg, err := h.newConfiguration(namespace)
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
func (h *HelmRunner) Uninstall(releaseName, namespace string) error {
	cfg, err := h.newConfiguration(namespace)
	if err != nil {
		return err
	}
	uninst := action.NewUninstall(cfg)
	if _, err := uninst.Run(releaseName); err != nil {
		// Helm's "release not found" is the no-op case; everything else is
		// a real error.
		if isReleaseNotFound(err) {
			return nil
		}
		return fmt.Errorf("uninstall: %w", err)
	}
	return nil
}

// Get returns the latest release info, or nil if not installed.
func (h *HelmRunner) Get(releaseName, namespace string) (*release.Release, error) {
	cfg, err := h.newConfiguration(namespace)
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

// We import repo here so `go vet` doesn't complain about an unused import
// when downstream packages add repo-related code; the value is harmless.
var _ = repo.File{}
