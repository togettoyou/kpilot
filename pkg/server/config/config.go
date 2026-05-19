package config

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

// DefaultAdminPassword is the fallback used when ADMIN_PASSWORD isn't
// set in the environment. Exported so other packages can check whether
// the deployment is still using it and surface a rotation warning to
// the user. SECURITY: any production deployment must override this.
const DefaultAdminPassword = "kpilot123"

type Config struct {
	HTTPAddr      string
	GRPCAddr      string
	DSN           string
	AdminUsername string
	AdminPassword string
	// AdminPasswordIsDefault is true when ADMIN_PASSWORD wasn't set
	// and we fell back to DefaultAdminPassword. Handlers surface this
	// to the frontend so the user sees a banner reminding them to
	// rotate before exposing the deployment publicly.
	AdminPasswordIsDefault bool
	JWTSecret              string
	CORSOrigins            []string // allowed origins; empty = dev permissive mode
	// StaticDir is the path to a built frontend SPA on disk. When set
	// the HTTP server serves the directory as a static asset tree and
	// falls back to index.html for any unknown route — the standard
	// SPA-friendly behavior. When empty (dev), the frontend is served
	// by UmiJS on its own port and the Go server is API-only.
	StaticDir string

	// BootstrapLocalClusterToken auto-creates a cluster row named
	// BootstrapLocalClusterName on first start so an all-in-one
	// helm install (server + worker in the same release) doesn't need
	// the admin to log in and create the cluster manually before the
	// worker can register. Enabled when token is non-empty.
	//
	// Idempotent across restarts: if a cluster with the same NAME
	// already exists the bootstrap silently no-ops (preserves any
	// edits the admin made via UI). Token-rotation flows go through
	// UI's "regenerate token" — this env is for the initial install,
	// not ongoing management.
	BootstrapLocalClusterName  string
	BootstrapLocalClusterToken string
}

func Load() *Config {
	loadDotEnv()

	jwtSecret := envOr("JWT_SECRET", "")
	if jwtSecret == "" {
		jwtSecret = randomHex(32)
		log.Println("[config] JWT_SECRET not set, using random secret (tokens will be invalidated on restart)")
	}

	adminPassword := envOr("ADMIN_PASSWORD", "")
	adminPasswordIsDefault := false
	if adminPassword == "" {
		adminPassword = DefaultAdminPassword
		adminPasswordIsDefault = true
		log.Printf("[config] ADMIN_PASSWORD not set, using default %q — rotate before exposing this deployment publicly", DefaultAdminPassword)
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
		HTTPAddr:                   envOr("HTTP_ADDR", ":8080"),
		GRPCAddr:                   envOr("GRPC_ADDR", ":9090"),
		DSN:                        envOr("DSN", "postgres://kpilot:kpilot123@localhost:5432/kpilot?sslmode=disable"),
		AdminUsername:              envOr("ADMIN_USERNAME", "kpilot"),
		AdminPassword:              adminPassword,
		AdminPasswordIsDefault:     adminPasswordIsDefault,
		JWTSecret:                  jwtSecret,
		CORSOrigins:                corsOrigins,
		StaticDir:                  envOr("STATIC_DIR", ""),
		BootstrapLocalClusterName:  envOr("BOOTSTRAP_LOCAL_CLUSTER_NAME", "local"),
		BootstrapLocalClusterToken: envOr("BOOTSTRAP_LOCAL_CLUSTER_TOKEN", ""),
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// loadDotEnv looks for a .env file in the current working directory and
// folds its values into the process environment. Silently no-ops when
// the file is absent — the only "supported" deployment path remains
// real env vars (Kubernetes pod env, shell exports), and .env is a
// convenience for local dev. godotenv.Load (not Overload) preserves
// already-set vars so shell exports always win.
func loadDotEnv() {
	if err := godotenv.Load(); err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[config] failed to load .env: %v", err)
		}
		return
	}
	log.Println("[config] loaded .env")
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
