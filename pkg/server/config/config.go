package config

import "os"

type Config struct {
	HTTPAddr string
	GRPCAddr string
	DSN      string
}

func Load() *Config {
	return &Config{
		HTTPAddr: envOr("HTTP_ADDR", ":8080"),
		GRPCAddr: envOr("GRPC_ADDR", ":9090"),
		DSN:      envOr("DSN", "postgres://kpilot:kpilot123@localhost:5432/kpilot?sslmode=disable"),
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
