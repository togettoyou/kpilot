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

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	api := r.Group("/api/v1")
	{
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
	}

	return r
}
