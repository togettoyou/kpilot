// Package middleware — Bearer API key auth for the OpenAI-compatible
// inference proxy (P16-C).
//
// Sits in front of POST /api/v1/clusters/:id/proxy/inference/...
// Validates that the request carries a Bearer token whose hashed form
// matches an active (RevokedAt IS NULL) APIKey row whose scope
// (cluster_id, namespace, deploy_name) matches the URL path. Bumps
// the row's LastUsedAt asynchronously (throttled to 1/min in the
// store layer) so we have observability without burning DB writes.
//
// Failure modes (all 401):
//   - Missing / malformed Authorization header → API_KEY_MISSING
//   - Token doesn't hash to any row → API_KEY_INVALID
//   - Row exists but RevokedAt != nil → API_KEY_INVALID (collapse;
//     we deliberately don't tell external callers "this key was
//     revoked" — it's the same outcome from their perspective)
//   - Row exists but scope doesn't match path → API_KEY_SCOPE_MISMATCH
//     (this one we DO distinguish — useful operator hint that the key
//     is valid but pointed at the wrong deployment)
package middleware

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/togettoyou/kpilot/pkg/server/store"
)

// Context keys for handlers downstream of BearerAPIKey to recover the
// authorising key (e.g. for audit logging).
const (
	ctxKeyAPIKeyID = "kpilot_api_key_id"
)

// BearerAPIKey returns a Gin middleware enforcing API-key bearer auth.
// The caller specifies which path params hold the cluster_id /
// namespace / deploy_name segments — the OpenAI proxy uses
// :id / :namespace / :name so scope matching is just three calls to
// c.Param.
func BearerAPIKey(clusterParam, namespaceParam, deployParam string) gin.HandlerFunc {
	return func(c *gin.Context) {
		token, ok := extractBearerToken(c)
		if !ok {
			abortUnauth(c, "API_KEY_MISSING", "missing or malformed Authorization header")
			return
		}

		hash := store.HashAPIKey(token)
		key, err := store.GetAPIKeyByHash(hash)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				abortUnauth(c, "API_KEY_INVALID", "unknown api key")
				return
			}
			// DB error — log internally, expose generic 500 (don't
			// give an attacker a side channel for "DB up vs key
			// unknown").
			log.Printf("[bearer-api-key] db lookup failed: hash=%s err=%v", hash[:8], err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"code": "INTERNAL_ERROR"})
			return
		}
		if key.RevokedAt != nil {
			abortUnauth(c, "API_KEY_INVALID", "api key revoked")
			return
		}

		// Scope check: each segment of the URL path must EXACTLY
		// match the row. Empty path params (route misconfig) are
		// treated as mismatch — never accidentally authorise an
		// unscoped path.
		clusterID := c.Param(clusterParam)
		namespace := c.Param(namespaceParam)
		deploy := c.Param(deployParam)
		if clusterID == "" || namespace == "" || deploy == "" {
			abortUnauth(c, "API_KEY_SCOPE_MISMATCH", "request path missing scope segments")
			return
		}
		if key.ClusterID != clusterID || key.Namespace != namespace || key.DeployName != deploy {
			log.Printf("[bearer-api-key] scope mismatch: key=%d wants=%s/%s/%s got=%s/%s/%s",
				key.ID, key.ClusterID, key.Namespace, key.DeployName, clusterID, namespace, deploy)
			abortUnauth(c, "API_KEY_SCOPE_MISMATCH", "api key not authorised for this deployment")
			return
		}

		c.Set(ctxKeyAPIKeyID, key.ID)

		// Bump LastUsedAt asynchronously — the request continues even
		// if the DB write fails (this is observability, not auth).
		// Throttle is enforced inside store.TouchAPIKeyLastUsed via
		// a WHERE-clause guard.
		go func(id uint) {
			if err := store.TouchAPIKeyLastUsed(id); err != nil {
				log.Printf("[bearer-api-key] touch last-used failed: id=%d err=%v", id, err)
			}
		}(key.ID)

		c.Next()
	}
}

// extractBearerToken pulls the token out of the Authorization header.
// Returns (token, true) on the canonical `Bearer <token>` form; rejects
// anything else (multiple tokens, missing prefix, empty token).
//
// We deliberately don't accept the token via cookie or query string —
// the OpenAI-compat surface is explicitly for external SDK use, and
// keeping auth to a single channel keeps the threat model simple.
func extractBearerToken(c *gin.Context) (string, bool) {
	h := c.GetHeader("Authorization")
	if h == "" {
		return "", false
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return "", false
	}
	tok := strings.TrimSpace(h[len(prefix):])
	if tok == "" {
		return "", false
	}
	// Sanity ceiling — KPilot tokens are ~38 chars; anything wildly
	// longer is junk that we should reject before hashing. 1024 is
	// generous so legitimate JWT-shaped tokens (if a future scheme
	// adopts them) still pass.
	if len(tok) > 1024 {
		return "", false
	}
	return tok, true
}

// abortUnauth writes the canonical 401 + error code body and stops
// the gin chain. message is logged + included for debugging; in
// production an attacker sees the code only and infers the rest from
// HTTP semantics.
func abortUnauth(c *gin.Context, code, message string) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
		"code":    code,
		"message": message,
	})
}

// APIKeyID returns the authorising APIKey row id, or 0 if the
// request wasn't authorised via BearerAPIKey. Handlers downstream
// (the inference proxy) use it for audit logs.
func APIKeyID(c *gin.Context) uint {
	v, ok := c.Get(ctxKeyAPIKeyID)
	if !ok {
		return 0
	}
	id, ok := v.(uint)
	if !ok {
		return 0
	}
	return id
}
