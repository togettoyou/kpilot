// Package plugins owns the built-in Helm chart bundles that ship
// inside the server binary. Today: volcano-vgpu-device-plugin (the
// only Volcano CRD-system component without a published Helm chart).
//
// Build flow:
//
//   1. embed.FS holds the chart source files (Chart.yaml + values.yaml
//      + templates/*) committed under `charts/<name>/`.
//   2. At server boot, PackageBuiltinChart extracts the files to a
//      temp dir, loads them via Helm's loader.LoadDir, repackages as
//      a .tgz with chartutil.Save, reads the bytes back.
//   3. The .tgz bytes + sha256 are written as a PluginBlob, and the
//      Plugin row references ChartBlobID. Same wire shape as user-
//      uploaded local charts — the existing Worker codepath just
//      works.
//
// Why not commit a pre-built .tgz?
//
//   - Round-tripping the chart through Helm at boot catches "I edited
//     templates/* and forgot to repackage" before it ever reaches a
//     production worker.
//   - The .tgz is content-addressed by sha256; committing it means
//     reviewers diff opaque binary bytes. Source files in git diff
//     cleanly; the .tgz is regenerated identically (Helm uses tar's
//     reproducible mode).
//   - Repackaging cost is ~10 ms per chart at boot — negligible vs
//     the seeding query budget.
package plugins

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/chartutil"
)

// volcanoVGPUFS embeds the chart sources committed under
// charts/volcano-vgpu/. Filename pattern matches Helm's expected
// layout so loader.LoadDir works without massaging.
//
//go:embed charts/volcano-vgpu/Chart.yaml charts/volcano-vgpu/values.yaml charts/volcano-vgpu/templates
var volcanoVGPUFS embed.FS

// VolcanoVGPUChartName must match Chart.yaml's `name:` field — Helm
// produces `<name>-<version>.tgz` and we read that filename back.
const VolcanoVGPUChartName = "volcano-vgpu-device-plugin"

// PackagedChart bundles what callers (e.g. seed.go) need to upsert a
// PluginBlob + reference it from a Plugin row.
type PackagedChart struct {
	Filename string // <name>-<version>.tgz
	Bytes    []byte
	SHA256   string // lowercase hex
	Version  string // Chart.yaml's version field
}

// PackageVolcanoVGPU rolls the embedded chart sources into a .tgz at
// boot. Idempotent: callers can invoke it once per server start and
// hand the result to UpsertPluginBlob; the sha256-keyed dedupe at
// the blob layer means repeated boots don't churn the DB.
func PackageVolcanoVGPU() (*PackagedChart, error) {
	return packageEmbeddedChart(volcanoVGPUFS, "charts/volcano-vgpu")
}

// packageEmbeddedChart is the generic helper. Steps:
//
//	1. Walk fsys rooted at fsRoot, mirror to a temp dir on disk so
//	   Helm's loader (which only takes filesystem paths) can read it.
//	2. loader.LoadDir → *chart.Chart with templates parsed + values
//	   merged.
//	3. chartutil.Save into a second temp dir; Helm picks the filename
//	   from the chart's Name + Version.
//	4. Read the .tgz, sha256 it, clean up.
//
// Errors are wrapped with the step that failed so a broken chart
// (template parse error, missing Chart.yaml, etc.) surfaces in the
// server log with enough context to fix it without re-running.
func packageEmbeddedChart(fsys embed.FS, fsRoot string) (*PackagedChart, error) {
	srcDir, err := os.MkdirTemp("", "kpilot-chart-src-*")
	if err != nil {
		return nil, fmt.Errorf("mktemp src: %w", err)
	}
	defer os.RemoveAll(srcDir)

	// Mirror embed.FS → real filesystem. Helm chart loader needs a
	// real directory; it doesn't accept io/fs.FS yet (Helm 3.x).
	if err := mirrorEmbedFS(fsys, fsRoot, srcDir); err != nil {
		return nil, fmt.Errorf("mirror chart files: %w", err)
	}

	ch, err := loader.LoadDir(srcDir)
	if err != nil {
		return nil, fmt.Errorf("helm loader: %w", err)
	}

	tgzDir, err := os.MkdirTemp("", "kpilot-chart-tgz-*")
	if err != nil {
		return nil, fmt.Errorf("mktemp tgz: %w", err)
	}
	defer os.RemoveAll(tgzDir)

	tgzPath, err := chartutil.Save(ch, tgzDir)
	if err != nil {
		return nil, fmt.Errorf("helm save: %w", err)
	}

	bytes, err := os.ReadFile(tgzPath)
	if err != nil {
		return nil, fmt.Errorf("read tgz: %w", err)
	}
	sum := sha256.Sum256(bytes)
	return &PackagedChart{
		Filename: filepath.Base(tgzPath),
		Bytes:    bytes,
		SHA256:   hex.EncodeToString(sum[:]),
		Version:  ch.Metadata.Version,
	}, nil
}

// mirrorEmbedFS copies every file under fsRoot (in fsys) into dstDir
// on disk, preserving the relative path. Used to bridge embed.FS to
// Helm's directory-only loader. We open each file via io.Copy rather
// than ReadFile-then-WriteFile so very large templates (the vgpu
// chart's MIG geometries CM is ~3 KB; future charts may be bigger)
// don't all land in RAM at once.
func mirrorEmbedFS(fsys embed.FS, fsRoot, dstDir string) error {
	return fs.WalkDir(fsys, fsRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(fsRoot, path)
		if relErr != nil {
			return relErr
		}
		dst := filepath.Join(dstDir, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		src, openErr := fsys.Open(path)
		if openErr != nil {
			return openErr
		}
		defer src.Close()
		out, createErr := os.Create(dst)
		if createErr != nil {
			return createErr
		}
		defer out.Close()
		_, copyErr := io.Copy(out, src)
		return copyErr
	})
}
