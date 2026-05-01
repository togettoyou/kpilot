package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/api/middleware"
)

type loginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

func Login(adminUser, adminPass, jwtSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req loginRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if req.Username != adminUser || req.Password != adminPass {
			c.JSON(http.StatusOK, gin.H{"status": "error", "message": "incorrect username or password"})
			return
		}
		token, err := middleware.IssueToken(jwtSecret, req.Username)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to issue token"})
			return
		}
		middleware.SetCookie(c, token)
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	}
}

func Me() gin.HandlerFunc {
	return func(c *gin.Context) {
		username, _ := c.Get("username")
		c.JSON(http.StatusOK, gin.H{
			"data": gin.H{
				"name":   username,
				"access": "admin",
			},
			"success": true,
		})
	}
}

func Logout() gin.HandlerFunc {
	return func(c *gin.Context) {
		middleware.ClearCookie(c)
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	}
}
