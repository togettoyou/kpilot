package plugin

import (
	"fmt"
	"os"
	"path/filepath"
)

// ChartCache stores Helm chart tarballs on local disk, keyed by sha256.
// Both the manager (writes on PluginCommand) and the reconciler (reads
// on Helm install) talk to it through this single type so the on-disk
// layout is in one place.
//
// Layout: <root>/<sha256>.tgz
//
// The cache is intentionally durable beyond the Worker pod lifetime —
// charts can run several MB and re-pushing on every restart wastes
// bandwidth. Operators are expected to mount a persistent volume at
// the cache root.
type ChartCache struct {
	root string
}

func NewChartCache(root string) (*ChartCache, error) {
	if root == "" {
		root = "/var/lib/kpilot/charts"
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", root, err)
	}
	return &ChartCache{root: root}, nil
}

func (c *ChartCache) pathFor(sha string) string {
	return filepath.Join(c.root, sha+".tgz")
}

// Has reports whether a chart with the given sha256 is on disk.
func (c *ChartCache) Has(sha string) bool {
	if sha == "" {
		return false
	}
	_, err := os.Stat(c.pathFor(sha))
	return err == nil
}

// Path returns the on-disk path for the given sha256, or empty string if
// the chart isn't cached.
func (c *ChartCache) Path(sha string) string {
	if !c.Has(sha) {
		return ""
	}
	return c.pathFor(sha)
}

// Put writes the chart bytes to the cache under a name derived from
// the declared sha. Idempotent: if the file already exists, no-op.
//
// We DON'T verify sha256(content) == declared. Server-side declared
// sha is hashed over the chart's embed.FS source files (stable across
// boots for dedupe), while the .tgz bytes themselves vary per Helm
// package run (tar entry mtimes change). Enforcing the equality
// would reject every local-chart install. The integrity-check angle
// is moot here — bytes arrive over the worker's own authenticated
// yamux session, not from an untrusted upload path.
func (c *ChartCache) Put(expectedSHA string, content []byte) error {
	if expectedSHA == "" {
		return fmt.Errorf("missing sha256")
	}
	dst := c.pathFor(expectedSHA)
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	// Write to a temp file in the same dir then rename, so concurrent
	// readers never observe a half-written tgz.
	tmp, err := os.CreateTemp(c.root, "chart-*.tgz.tmp")
	if err != nil {
		return fmt.Errorf("tempfile: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}
