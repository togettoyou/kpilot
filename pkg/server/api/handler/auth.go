package handler

import (
	"crypto/subtle"
	"net/http"
	"unicode/utf8"

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
		// Codepoint count per CLAUDE.md «字段长度限制» — DB-side varchar
		// caps are codepoint-based (PostgreSQL), so byte-counting would
		// over-eagerly reject valid 86-character Chinese usernames.
		if utf8.RuneCountInString(req.Username) > maxLoginUsernameLen ||
			utf8.RuneCountInString(req.Password) > maxLoginPasswordLen {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		// Constant-time compare so the response time doesn't leak
		// "username matched but password didn't". Both arms must run
		// to keep timing uniform; an early-return on Username mismatch
		// would defeat the point.
		userOK := subtle.ConstantTimeCompare([]byte(req.Username), []byte(adminUser)) == 1
		passOK := subtle.ConstantTimeCompare([]byte(req.Password), []byte(adminPass)) == 1
		if !userOK || !passOK {
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
