package config

import (
	"log"
	"os"

	"github.com/joho/godotenv"
)

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
	loadDotEnv()
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

// loadDotEnv folds a .env file in the current working directory into the
// process environment. Silently no-ops when absent. godotenv.Load (not
// Overload) preserves already-set vars so shell / pod env always wins.
func loadDotEnv() {
	if err := godotenv.Load(); err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[config] failed to load .env: %v", err)
		}
		return
	}
	log.Println("[config] loaded .env")
}
