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
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if req.Username != adminUser || req.Password != adminPass {
			// Login page handles this 200-level error directly; keep existing shape.
			c.JSON(http.StatusOK, gin.H{"status": "error", "code": "LOGIN_INCORRECT"})
			return
		}
		token, err := middleware.IssueToken(jwtSecret, req.Username)
		if err != nil {
			apiErrInternal(c, err)
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
