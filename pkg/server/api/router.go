package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/api/handler"
	"github.com/togettoyou/kpilot/pkg/server/api/middleware"
	"github.com/togettoyou/kpilot/pkg/server/config"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

func NewRouter(cfg *config.Config, gw *gateway.GatewayServer) *gin.Engine {
	r := gin.Default()

	// Build origin lookup set once.
	allowedOrigins := make(map[string]struct{}, len(cfg.CORSOrigins))
	for _, o := range cfg.CORSOrigins {
		allowedOrigins[o] = struct{}{}
	}
	devMode := len(allowedOrigins) == 0

	r.Use(func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			_, allowed := allowedOrigins[origin]
			if devMode || allowed {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Access-Control-Allow-Credentials", "true")
				c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
				c.Header("Access-Control-Max-Age", "86400")
			}
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	api := r.Group("/api/v1")
	{
		// Public — version banner shown in the UI header.
		api.GET("/version", handler.Version())

		auth := api.Group("/auth")
		auth.POST("/login", handler.Login(cfg.AdminUsername, cfg.AdminPassword, cfg.JWTSecret))
		auth.POST("/logout", handler.Logout())
		auth.GET("/me", middleware.Auth(cfg.JWTSecret), handler.Me())
	}

	protected := api.Group("", middleware.Auth(cfg.JWTSecret))
	{
		clusters := protected.Group("/clusters")
		clusters.POST("", handler.CreateCluster)
		clusters.GET("", handler.ListClusters)
		clusters.PATCH("/:id", handler.UpdateCluster)
		clusters.DELETE("/:id", handler.DeleteCluster)
		clusters.POST("/:id/token", handler.RegenerateToken(gw))
		clusters.GET("/:id/nodes", handler.ListNodes(gw))
		clusters.GET("/:id/gpu", handler.GetClusterGPU(gw))
		clusters.GET("/:id/namespaces", handler.ListNamespaces(gw))
		clusters.GET("/:id/workloads/:type", handler.ListWorkloads(gw))
		clusters.GET("/:id/workloads/:type/:name", handler.GetWorkload(gw))
		clusters.GET("/:id/workloads/:type/:name/describe", handler.DescribeWorkload(gw))
		clusters.PUT("/:id/workloads/:type/:name", handler.ApplyWorkload(gw))
		clusters.DELETE("/:id/workloads/:type/:name", handler.DeleteWorkload(gw))
		clusters.POST("/:id/apply", handler.ApplyYAML(gw))
		clusters.POST("/:id/delete-yaml", handler.DeleteYAML(gw))

		// Pod streaming endpoints (WebSocket). Auth is the same JWT cookie —
		// browsers send cookies on the WS handshake, so the Auth middleware
		// above runs first and rejects unauthenticated upgrades.
		clusters.GET("/:id/pods/:namespace/:name/logs", handler.PodLogs(gw))
		clusters.GET("/:id/pods/:namespace/:name/exec", handler.PodExec(gw))

		// Per-cluster plugin state (read-only registry view + enable/disable)
		clusters.GET("/:id/plugins", handler.ListClusterPlugins)
		clusters.POST("/:id/plugins/:name/enable", handler.EnablePlugin(gw))
		clusters.POST("/:id/plugins/:name/disable", handler.DisablePlugin(gw))

		// Reverse proxy to plugin-managed in-cluster Services. The browser
		// loads /api/v1/clusters/<id>/proxy/grafana/... and KPilot Server
		// forwards through the gRPC tunnel to the cluster's Grafana
		// Service. Auth lives in the JWT middleware above; the proxy
		// handler injects X-WEBAUTH-USER so the upstream sees a logged-in
		// session without ever asking for a password.
		//
		// `Any` covers GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS — Grafana's
		// API uses all of them.
		clusters.Any("/:id/proxy/:plugin/*path", handler.ProxyPlugin(gw))

		// Global plugin registry
		plugins := protected.Group("/plugins")
		plugins.GET("", handler.ListPlugins)
		plugins.POST("", handler.CreatePlugin)
		plugins.POST("/upload", handler.UploadPluginChart)
		plugins.GET("/:id", handler.GetPlugin)
		plugins.PATCH("/:id", handler.UpdatePlugin)
		plugins.DELETE("/:id", handler.DeletePlugin)
	}

	return r
}
