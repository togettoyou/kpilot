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
	CodeWorkerConflict       = "WORKER_CONFLICT"
	CodeResourceNotAvailable = "RESOURCE_NOT_AVAILABLE"
	CodePluginNotFound       = "PLUGIN_NOT_FOUND"
	CodePluginNameExists     = "PLUGIN_NAME_EXISTS"
	CodePluginBuiltinLocked  = "PLUGIN_BUILTIN_LOCKED"
	CodePluginChartMissing   = "PLUGIN_CHART_MISSING"
	CodePluginUploadTooLarge = "PLUGIN_UPLOAD_TOO_LARGE"
	CodePluginInUse          = "PLUGIN_IN_USE"
	CodePluginUninstalling   = "PLUGIN_UNINSTALLING"
	CodePluginNotEnabled     = "PLUGIN_NOT_ENABLED"
	CodePluginNotRunning     = "PLUGIN_NOT_RUNNING"
	CodeModelNotFound        = "MODEL_NOT_FOUND"
	CodeModelNameExists      = "MODEL_NAME_EXISTS"
	CodeModelBuiltinLocked   = "MODEL_BUILTIN_LOCKED"
	CodeLoginIncorrect       = "LOGIN_INCORRECT"
	// CodeProxyUpstream is the 502-style code used when the in-cluster
	// reverse proxy successfully dispatched through the worker but the
	// worker reported the upstream Service unreachable (DNS, dial,
	// timeout). The upstream error message rides along in `message`.
	CodeProxyUpstream = "PROXY_UPSTREAM_ERROR"
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

// apiErrDetail is the apiErr variant for cases where the upstream
// failure carries a free-form message the operator needs to see (e.g.
// reverse-proxy "could not dial Grafana: …"). Same shape as
// apiErrWorker but with a caller-specified status code and error code,
// so the frontend can route on `code` and surface `message` directly.
func apiErrDetail(c *gin.Context, status int, code, message string) {
	c.JSON(status, gin.H{"code": code, "message": message})
}
