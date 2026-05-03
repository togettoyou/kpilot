package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/api/middleware"
)

// Length caps for login credentials. Generous but bounded — single-
// tenant creds aren't bcrypt-compared so there's no CPU DoS angle, but
// the three-layer cap rule (CLAUDE.md / 后端开发规范) still applies.
const (
	maxLoginUsernameLen = 255
	maxLoginPasswordLen = 1024
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
		if len(req.Username) > maxLoginUsernameLen || len(req.Password) > maxLoginPasswordLen {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if req.Username != adminUser || req.Password != adminPass {
			// Login page handles this 200-level error directly; keep existing shape.
			c.JSON(http.StatusOK, gin.H{"status": "error", "code": CodeLoginIncorrect})
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
