package handler

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

// API error codes — must stay in sync with frontend locales errors.* keys.
const (
	CodeInvalidRequest       = "INVALID_REQUEST"
	CodeInternalError        = "INTERNAL_ERROR"
	CodeClusterNotFound      = "CLUSTER_NOT_FOUND"
	CodeClusterNameExists    = "CLUSTER_NAME_EXISTS"
	CodeClusterNotConnected  = "CLUSTER_NOT_CONNECTED"
	CodeWorkerError          = "WORKER_ERROR"
	CodeWorkerTimeout        = "WORKER_TIMEOUT"
	CodeNamespaceProtected   = "NAMESPACE_PROTECTED"
	CodePluginNotFound       = "PLUGIN_NOT_FOUND"
	CodePluginNameExists     = "PLUGIN_NAME_EXISTS"
	CodePluginBuiltinLocked  = "PLUGIN_BUILTIN_LOCKED"
	CodePluginChartMissing   = "PLUGIN_CHART_MISSING"
	CodePluginUploadTooLarge = "PLUGIN_UPLOAD_TOO_LARGE"
	CodePluginNamespaceLock  = "PLUGIN_NAMESPACE_LOCKED"
	CodePluginInUse          = "PLUGIN_IN_USE"
	CodeLoginIncorrect       = "LOGIN_INCORRECT"
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

// apiErrWorker returns a 400 with the worker's error message surfaced to the
// client. Worker errors are operation failures (K8s validation, conflicts, etc.)
// and are safe to expose.
func apiErrWorker(c *gin.Context, errMsg string) {
	c.JSON(http.StatusBadRequest, gin.H{"code": CodeWorkerError, "message": errMsg})
}
