// Package store — API key persistence for the OpenAI-compatible
// inference proxy (P16-C).
//
// Each row authorises Bearer-token access to ONE inference
// deployment, identified by (cluster_id, namespace, deploy_name).
// The token plaintext is shown once on creation and never stored;
// only the sha256 lives in the DB so a leaked DB dump can't be
// replayed against KPilot.
//
// Token shape: `kp-sk-<32 base64url chars>` (~24 bytes of entropy).
// The `kp-sk-` prefix is a grep marker for log redaction and lets
// operators visually distinguish KPilot keys from upstream provider
// keys in their secret stores.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// APIKey is one Bearer-token credential for the OpenAI-compat
// /proxy/inference/ endpoint. Scope is per-deployment: the key
// only authorises calls whose URL path matches its
// (cluster_id, namespace, deploy_name) triple, so a leaked key can
// only be used against the model it was minted for — not arbitrary
// in-cluster Services.
type APIKey struct {
	ID uint `gorm:"primaryKey;autoIncrement" json:"id"`

	// Name is the operator-facing label. Free-form, 255 char cap.
	Name string `gorm:"type:varchar(255);not null" json:"name"`

	// TokenHash is sha256-hex of the plaintext token. Indexed for
	// O(1) lookup in the middleware. Unique to make collisions a DB
	// error rather than a silent overwrite (collision is
	// astronomically improbable with 24 bytes of entropy, but the
	// uniqueIndex documents intent).
	TokenHash string `gorm:"type:varchar(64);not null;uniqueIndex" json:"-"`

	// TokenPrefix is the first 8 plaintext chars (e.g. "kp-sk-Ab")
	// so operators can identify a key in the UI list without us
	// storing the plaintext. Not authoritative — never use for
	// auth, only display.
	TokenPrefix string `gorm:"type:varchar(16);not null" json:"token_prefix"`

	// Scope: this key only authorises requests targeting EXACTLY
	// this cluster/namespace/deploy_name. The middleware compares
	// against the URL path before forwarding.
	ClusterID  string `gorm:"type:varchar(36);not null;index" json:"cluster_id"`
	Namespace  string `gorm:"type:varchar(63);not null" json:"namespace"`
	DeployName string `gorm:"type:varchar(253);not null" json:"deploy_name"`

	// LastUsedAt is bumped asynchronously by the auth middleware
	// (throttled — see TouchAPIKeyLastUsed) so a constantly-pinged
	// key doesn't generate a DB write per request. nil if the key
	// has never been used.
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`

	// RevokedAt is nil for active keys. A revoked key stays in the
	// table for audit; the middleware rejects requests where
	// RevokedAt != nil. Hard-deleting (DELETE /api/v1/api-keys/:id)
	// is also supported — sets the row gone entirely, useful for
	// keys that turn out to be test artifacts.
	RevokedAt *time.Time `json:"revoked_at,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ErrAPIKeyNotFound is the sentinel for "no row matched this token
// hash / id". Handler translates to API_KEY_INVALID for unauth
// requests and API_KEY_NOT_FOUND for the operator CRUD path.
var ErrAPIKeyNotFound = gorm.ErrRecordNotFound

// apiKeyTokenPrefix is the visible prefix on every minted token —
// grep marker for log redaction tools and the visual "this is a
// KPilot key" hint.
const apiKeyTokenPrefix = "kp-sk-"

// apiKeyEntropyBytes is the raw entropy that becomes the token
// suffix. 24 bytes → 32 base64url chars; well past the security
// margin of a Bearer credential (compare: GitHub PATs use 20-byte
// hex = 40 chars).
const apiKeyEntropyBytes = 24

// GenerateAPIKey produces a (plaintext, hash, displayPrefix) triple
// suitable for inserting an APIKey row. Plaintext is what we hand
// to the user; only the hash + displayPrefix go into the DB.
//
// Uses crypto/rand — failure is fatal (the OS entropy pool is
// broken or unavailable, which is an environment problem we
// shouldn't paper over).
func GenerateAPIKey() (plaintext, hashHex, displayPrefix string, err error) {
	buf := make([]byte, apiKeyEntropyBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", "", fmt.Errorf("generate api key entropy: %w", err)
	}
	suffix := base64.RawURLEncoding.EncodeToString(buf)
	plaintext = apiKeyTokenPrefix + suffix
	sum := sha256.Sum256([]byte(plaintext))
	hashHex = hex.EncodeToString(sum[:])
	// First 8 plaintext chars = "kp-sk-Ab" — enough to recognise
	// the key in a list, not enough to brute-force the rest.
	if len(plaintext) >= 8 {
		displayPrefix = plaintext[:8]
	} else {
		displayPrefix = plaintext
	}
	return plaintext, hashHex, displayPrefix, nil
}

// HashAPIKey reduces a plaintext token to the DB-stored sha256-hex.
// Middleware uses this to look up the row in O(1) without ever
// storing or logging the plaintext.
func HashAPIKey(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// CreateAPIKey inserts a new row. Caller fills name + scope +
// hash + display prefix from GenerateAPIKey output. Name
// uniqueness is NOT enforced (operators may want two keys named
// "production" for two clusters); the hash uniqueIndex catches
// the truly fatal collision case.
func CreateAPIKey(k *APIKey) error {
	return DB.Create(k).Error
}

// GetAPIKeyByHash is the auth middleware's hot path. Returns
// ErrAPIKeyNotFound for missing / unknown hashes; does NOT filter
// by revoked status (caller checks RevokedAt to distinguish
// 401 "unknown" from 401 "revoked" — distinguishing in logs is
// useful even though both look identical to the client).
func GetAPIKeyByHash(hashHex string) (*APIKey, error) {
	var k APIKey
	if err := DB.Where("token_hash = ?", hashHex).First(&k).Error; err != nil {
		return nil, err
	}
	return &k, nil
}

// GetAPIKeyByID is the CRUD path's lookup. Sorts on a primary
// key, so no index hint needed.
func GetAPIKeyByID(id uint) (*APIKey, error) {
	var k APIKey
	if err := DB.First(&k, id).Error; err != nil {
		return nil, err
	}
	return &k, nil
}

// ListAPIKeys returns all rows ordered newest-first so the
// management UI shows the most recently minted key at the top.
// Optional clusterID filter scopes the list to one cluster (used
// by per-cluster admin pages if they exist).
func ListAPIKeys(clusterID string) ([]APIKey, error) {
	var keys []APIKey
	q := DB.Model(&APIKey{})
	if clusterID != "" {
		q = q.Where("cluster_id = ?", clusterID)
	}
	if err := q.Order("created_at desc").Find(&keys).Error; err != nil {
		return nil, err
	}
	return keys, nil
}

// DeleteAPIKey hard-deletes the row. Revocation (soft-delete via
// RevokedAt) is the supported "I lost track of this key, kill it
// forever" path; hard delete is here for the "I created this for
// a one-off curl, clean up the row" path. The middleware treats
// both as 401 (missing row vs RevokedAt != nil).
func DeleteAPIKey(id uint) error {
	return DB.Delete(&APIKey{}, id).Error
}

// RevokeAPIKey sets RevokedAt to now. Idempotent — re-revoking
// a revoked key is a no-op.
func RevokeAPIKey(id uint) error {
	now := time.Now()
	return DB.Model(&APIKey{}).Where("id = ? AND revoked_at IS NULL", id).
		Update("revoked_at", &now).Error
}

// apiKeyTouchThrottle bounds how often we update LastUsedAt for a
// single key — the middleware fires this on every authorised
// request, but writing the DB on every chat token would be silly.
// 1 minute means a busy key gets ~1 write/min instead of many per
// second; the UI's "last seen X seconds ago" precision is plenty.
const apiKeyTouchThrottle = time.Minute

// TouchAPIKeyLastUsed bumps LastUsedAt to now if the existing
// value is more than apiKeyTouchThrottle ago. Caller invokes this
// from a goroutine after authorising a request — failure is
// logged in the caller, never propagated to the user (the request
// was valid; we just lost the "last used" datapoint).
func TouchAPIKeyLastUsed(id uint) error {
	now := time.Now()
	cutoff := now.Add(-apiKeyTouchThrottle)
	// Single UPDATE with a WHERE-clause throttle — atomic in
	// PostgreSQL; no row lock contention even under burst auth.
	return DB.Model(&APIKey{}).
		Where("id = ? AND (last_used_at IS NULL OR last_used_at < ?)", id, cutoff).
		Update("last_used_at", &now).Error
}

// errAPIKeyAlreadyRevoked is the sentinel for the (unlikely) race
// where two clients try to revoke the same key concurrently. Not
// surfaced to users; caller just treats "already revoked" as
// success.
var errAPIKeyAlreadyRevoked = errors.New("api key already revoked")
