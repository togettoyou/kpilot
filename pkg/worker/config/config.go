package config

import (
	"log"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
)

type Config struct {
	ServerAddr   string
	ClusterToken string
	// DataDir is the single persistent root for Worker state. Operators
	// mount one PVC here in production; ChartCacheDir + Helm's
	// repository config and cache all live under it by default.
	DataDir string
	// ChartCacheDir is where Worker writes Helm chart .tgz files
	// received from the Server. Defaults to $DataDir/charts; override
	// via CHART_CACHE_DIR if you need to split it onto a different
	// volume than DataDir.
	ChartCacheDir string
}

func Load() *Config {
	loadDotEnv()
	dataDir := envOr("DATA_DIR", "/var/lib/kpilot")
	return &Config{
		ServerAddr:    envOr("SERVER_ADDR", "localhost:9090"),
		ClusterToken:  envOr("CLUSTER_TOKEN", ""),
		DataDir:       dataDir,
		ChartCacheDir: envOr("CHART_CACHE_DIR", filepath.Join(dataDir, "charts")),
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
