package config

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"strings"
)

type Config struct {
	HTTPAddr      string
	GRPCAddr      string
	DSN           string
	AdminUsername string
	AdminPassword string
	JWTSecret     string
	CORSOrigins   []string // allowed origins; empty = dev permissive mode
}

func Load() *Config {
	jwtSecret := envOr("JWT_SECRET", "")
	if jwtSecret == "" {
		jwtSecret = randomHex(32)
		log.Println("[config] JWT_SECRET not set, using random secret (tokens will be invalidated on restart)")
	}

	adminPassword := envOr("ADMIN_PASSWORD", "")
	if adminPassword == "" {
		adminPassword = "admin123"
		log.Println("[config] ADMIN_PASSWORD not set, using default: admin123")
	}

	var corsOrigins []string
	if v := os.Getenv("CORS_ORIGINS"); v != "" {
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				corsOrigins = append(corsOrigins, o)
			}
		}
	}

	return &Config{
		HTTPAddr:      envOr("HTTP_ADDR", ":8080"),
		GRPCAddr:      envOr("GRPC_ADDR", ":9090"),
		DSN:           envOr("DSN", "postgres://kpilot:kpilot123@localhost:5432/kpilot?sslmode=disable"),
		AdminUsername: envOr("ADMIN_USERNAME", "admin"),
		AdminPassword: adminPassword,
		JWTSecret:     jwtSecret,
		CORSOrigins:   corsOrigins,
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
