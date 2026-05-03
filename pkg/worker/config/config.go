package config

import "os"

type Config struct {
	ServerAddr   string
	ClusterToken string
	// ChartCacheDir is where Worker writes Helm chart .tgz files received
	// from the Server. Operators are expected to mount a persistent volume
	// here so cache survives pod restarts (charts are several MB and
	// re-pushing on every restart wastes bandwidth).
	ChartCacheDir string
}

func Load() *Config {
	return &Config{
		ServerAddr:    envOr("SERVER_ADDR", "localhost:9090"),
		ClusterToken:  envOr("CLUSTER_TOKEN", ""),
		ChartCacheDir: envOr("CHART_CACHE_DIR", "/var/lib/kpilot/charts"),
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
