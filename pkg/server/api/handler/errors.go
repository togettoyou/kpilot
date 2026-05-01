package handler

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

// API error codes — must stay in sync with frontend locales errors.* keys.
const (
	CodeInvalidRequest    = "INVALID_REQUEST"
	CodeInternalError     = "INTERNAL_ERROR"
	CodeClusterNotFound   = "CLUSTER_NOT_FOUND"
	CodeClusterNameExists = "CLUSTER_NAME_EXISTS"
)

// apiErr writes a JSON error response with the given code.
func apiErr(c *gin.Context, status int, code string) {
	c.JSON(status, gin.H{"code": code})
}

// apiErrInternal logs the real error server-side and returns a generic 500 to
// the client, so internal details are never leaked.
func apiErrInternal(c *gin.Context, err error) {
	log.Printf("[handler] internal error: %v", err)
	c.JSON(http.StatusInternalServerError, gin.H{"code": CodeInternalError})
}
