package handler

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// Field length caps must mirror the DB column types and the frontend
// form maxLength props — defense-in-depth so a hand-rolled API call
// can't slip oversized text past us. Counted in **runes** (characters)
// not bytes so the limit matches what the frontend's antd Input
// maxLength enforces; otherwise a Chinese description that fits the
// frontend cap (each char counted once) gets rejected on the backend
// (each char counted as 3 UTF-8 bytes).
const (
	maxClusterNameLen = 255
	maxClusterDescLen = 500
)

type createClusterRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
}

func (r *createClusterRequest) validate() string {
	if utf8.RuneCountInString(r.Name) > maxClusterNameLen ||
		utf8.RuneCountInString(r.Description) > maxClusterDescLen {
		return CodeInvalidRequest
	}
	return ""
}

func CreateCluster(c *gin.Context) {
	var req createClusterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if code := req.validate(); code != "" {
		apiErr(c, http.StatusBadRequest, code)
		return
	}

	exists, err := store.ClusterExists(req.Name)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	if exists {
		apiErr(c, http.StatusConflict, CodeClusterNameExists)
		return
	}

	token, err := generateToken()
	if err != nil {
		apiErrInternal(c, err)
		return
	}

	cluster := &store.Cluster{
		ID:          uuid.New().String(),
		Name:        req.Name,
		Token:       token,
		Status:      store.ClusterStatusOffline,
		Description: req.Description,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	if err = store.CreateCluster(cluster); err != nil {
		apiErrInternal(c, err)
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"id":          cluster.ID,
		"name":        cluster.Name,
		"token":       token,
		"status":      cluster.Status,
		"description": cluster.Description,
		"created_at":  cluster.CreatedAt,
		"updated_at":  cluster.UpdatedAt,
	})
}

func ListClusters(c *gin.Context) {
	clusters, err := store.ListClusters()
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusOK, clusters)
}

func DeleteCluster(c *gin.Context) {
	id := c.Param("id")
	if err := store.DeleteCluster(id); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

type updateClusterRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
}

func (r *updateClusterRequest) validate() string {
	if utf8.RuneCountInString(r.Name) > maxClusterNameLen ||
		utf8.RuneCountInString(r.Description) > maxClusterDescLen {
		return CodeInvalidRequest
	}
	return ""
}

func UpdateCluster(c *gin.Context) {
	id := c.Param("id")
	var req updateClusterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if code := req.validate(); code != "" {
		apiErr(c, http.StatusBadRequest, code)
		return
	}
	exists, err := store.ClusterExists(req.Name)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	if exists {
		// Allow updating to the same name (e.g. only changing description).
		cluster, err := store.GetClusterByID(id)
		if err != nil || cluster.Name != req.Name {
			apiErr(c, http.StatusConflict, CodeClusterNameExists)
			return
		}
	}
	if err = store.UpdateCluster(id, req.Name, req.Description); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func RegenerateToken(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if _, err := store.GetClusterByID(id); err != nil {
			apiErr(c, http.StatusNotFound, CodeClusterNotFound)
			return
		}
		token, err := generateToken()
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		if err = store.UpdateClusterToken(id, token); err != nil {
			apiErrInternal(c, err)
			return
		}
		gw.KickWorker(id)
		c.JSON(http.StatusOK, gin.H{"token": token})
	}
}
