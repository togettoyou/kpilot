package config

import "os"

type Config struct {
	ServerAddr   string
	ClusterToken string
}

func Load() *Config {
	return &Config{
		ServerAddr:   envOr("SERVER_ADDR", "localhost:9090"),
		ClusterToken: envOr("CLUSTER_TOKEN", ""),
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
