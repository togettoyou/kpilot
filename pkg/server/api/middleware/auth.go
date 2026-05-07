package middleware

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// sameSite is applied before every SetCookie call to protect against CSRF.
const sameSite = http.SameSiteLaxMode

const cookieName = "kpilot_token"
const tokenTTL = 24 * time.Hour

type Claims struct {
	Username string `json:"username"`
	jwt.RegisteredClaims
}

func IssueToken(secret, username string) (string, error) {
	claims := Claims{
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(tokenTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
}

func ParseToken(secret, tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}
	return nil, jwt.ErrTokenInvalidClaims
}

func Auth(jwtSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		tokenStr, err := c.Cookie(cookieName)
		if err != nil || tokenStr == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		claims, err := ParseToken(jwtSecret, tokenStr)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Set("username", claims.Username)
		c.Next()
	}
}

// isSecureRequest returns true when the request reached the server
// over TLS — either directly (c.Request.TLS != nil) or through a
// reverse proxy that sets X-Forwarded-Proto=https. Used to decide
// whether the auth cookie should carry the Secure flag: forcing
// Secure=true on plain-HTTP localhost would prevent the cookie from
// being sent at all on dev. Production behind HTTPS picks it up
// automatically without needing a separate env var.
func isSecureRequest(c *gin.Context) bool {
	if c.Request.TLS != nil {
		return true
	}
	return c.GetHeader("X-Forwarded-Proto") == "https"
}

func SetCookie(c *gin.Context, token string) {
	c.SetSameSite(sameSite)
	c.SetCookie(cookieName, token, int(tokenTTL.Seconds()), "/", "", isSecureRequest(c), true)
}

func ClearCookie(c *gin.Context) {
	c.SetSameSite(sameSite)
	c.SetCookie(cookieName, "", -1, "/", "", isSecureRequest(c), true)
}
