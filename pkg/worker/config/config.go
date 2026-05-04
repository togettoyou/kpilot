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
	// mount one PVC here in production; chart .tgz cache and Helm's
	// repository config + cache all live under it.
	DataDir string
	// ClusterDomain is this cluster's K8s DNS suffix (CoreDNS default
	// "cluster.local"). Reported to Server at registration time so Server's
	// reverse proxy can build FQDNs for in-cluster Service URLs. Override
	// only if the cluster was bootstrapped with a non-default kubelet
	// --cluster-domain; the short-form ".svc" lookup fails on those.
	ClusterDomain string
}

// ChartCacheDir is where Worker writes Helm chart .tgz bytes received
// from the Server. Always $DataDir/charts — operators tune the parent
// via DATA_DIR rather than splitting paths.
func (c *Config) ChartCacheDir() string {
	return filepath.Join(c.DataDir, "charts")
}

func Load() *Config {
	loadDotEnv()
	return &Config{
		ServerAddr:    envOr("SERVER_ADDR", "localhost:9090"),
		ClusterToken:  envOr("CLUSTER_TOKEN", ""),
		DataDir:       envOr("DATA_DIR", "/var/lib/kpilot"),
		ClusterDomain: envOr("CLUSTER_DOMAIN", "cluster.local"),
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
