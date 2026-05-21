// Package handler — API key CRUD for the OpenAI-compatible
// inference proxy (P16-C).
//
// Operators create one APIKey per (cluster, namespace, deployment)
// triple. The minted plaintext is shown ONCE; the DB only stores the
// sha256 hash + a display prefix. Same pattern as the cluster Token
// regeneration UI — protect the operator from accidentally losing
// the secret by making it impossible to recover later.
package handler

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/togettoyou/kpilot/pkg/server/store"
)

const (
	maxAPIKeyNameLen = 255
)

// dns1123Re matches K8s namespace / deployment name rules — the auth
// scope must reference a real-looking deployment. We don't *verify*
// the deployment exists at create time (it can be created after the
// key, e.g. dev workflow: mint key → write deployment YAML referencing
// it). Just shape-check.
var apiKeyDNS1123Re = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// createAPIKeyRequest is the wire shape of POST /api/v1/api-keys.
// Name is operator-facing; the scope fields nail the key down to one
// inference deployment.
type createAPIKeyRequest struct {
	Name       string `json:"name" binding:"required"`
	ClusterID  string `json:"cluster_id" binding:"required"`
	Namespace  string `json:"namespace" binding:"required"`
	DeployName string `json:"deploy_name" binding:"required"`
}

// createAPIKeyResponse carries the plaintext token in a one-shot
// reply. Frontend MUST surface this clearly + offer copy-to-clipboard;
// it's gone after the operator navigates away.
type createAPIKeyResponse struct {
	Key   *store.APIKey `json:"key"`
	Token string        `json:"token"` // plaintext, shown once
}

// CreateAPIKey mints a new token. Validates name length + scope
// shape, generates entropy via store.GenerateAPIKey, inserts the row,
// returns key metadata + the plaintext token.
func CreateAPIKey(c *gin.Context) {
	var req createAPIKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if utf8.RuneCountInString(req.Name) == 0 || utf8.RuneCountInString(req.Name) > maxAPIKeyNameLen {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if len(req.ClusterID) > 36 || req.ClusterID == "" {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if !apiKeyDNS1123Re.MatchString(req.Namespace) || len(req.Namespace) > 63 {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if !apiKeyDNS1123Re.MatchString(req.DeployName) || len(req.DeployName) > 253 {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}

	// Verify the cluster actually exists — a key minted for a
	// non-existent cluster_id is dead weight forever. (We don't
	// verify the namespace / deployment because that's deferred per
	// the design note above; cluster ID is the routing-essential
	// piece, so it's worth one DB round-trip.)
	if _, err := store.GetClusterByID(req.ClusterID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodeClusterNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}

	plaintext, hash, prefix, err := store.GenerateAPIKey()
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	row := &store.APIKey{
		Name:        req.Name,
		TokenHash:   hash,
		TokenPrefix: prefix,
		ClusterID:   req.ClusterID,
		Namespace:   req.Namespace,
		DeployName:  req.DeployName,
	}
	if err := store.CreateAPIKey(row); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusCreated, createAPIKeyResponse{Key: row, Token: plaintext})
}

// ListAPIKeys returns every row, newest first. Optional ?cluster_id=
// filters to one cluster. Plaintext tokens are never included.
func ListAPIKeys(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	keys, err := store.ListAPIKeys(clusterID)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	if keys == nil {
		keys = []store.APIKey{}
	}
	c.JSON(http.StatusOK, keys)
}

// RevokeAPIKey marks a key as revoked. Idempotent — revoking an
// already-revoked key returns 200 anyway. Hard delete is a separate
// endpoint (DeleteAPIKey) for the "remove this entirely" case.
func RevokeAPIKey(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if _, err := store.GetAPIKeyByID(uint(id)); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodeAPIKeyNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}
	if err := store.RevokeAPIKey(uint(id)); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// DeleteAPIKey hard-deletes the row. Used for the "this was a test
// key, clean up" case. The middleware will 401 any further calls
// using the leaked plaintext, same as revoke, so security-wise the
// two paths are equivalent — delete just doesn't leave audit history.
func DeleteAPIKey(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if _, err := store.GetAPIKeyByID(uint(id)); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodeAPIKeyNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}
	if err := store.DeleteAPIKey(uint(id)); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
