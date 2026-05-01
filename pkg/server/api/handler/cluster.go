package handler

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/togettoyou/kpilot/pkg/server/store"
)

type createClusterRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
}

func CreateCluster(c *gin.Context) {
	var req createClusterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	exists, err := store.ClusterExists(req.Name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if exists {
		c.JSON(http.StatusConflict, gin.H{"error": "cluster name already exists"})
		return
	}

	token, err := generateToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"id":          cluster.ID,
		"name":        cluster.Name,
		"token":       token, // 只在创建时返回一次
		"description": cluster.Description,
		"created_at":  cluster.CreatedAt,
	})
}

func ListClusters(c *gin.Context) {
	clusters, err := store.ListClusters()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, clusters)
}

func DeleteCluster(c *gin.Context) {
	id := c.Param("id")
	if err := store.DeleteCluster(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
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
