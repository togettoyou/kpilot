package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	sigsyaml "sigs.k8s.io/yaml"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

const workerTimeout = 30 * time.Second
const maxBodySize = 1 << 20 // 1 MB — sufficient for any K8s manifest

type gvkInfo struct {
	group, version, kind string
}

// resourceGVK maps the URL :type segment to Kubernetes GVK.
var resourceGVK = map[string]gvkInfo{
	"deployments":             {"apps", "v1", "Deployment"},
	"statefulsets":            {"apps", "v1", "StatefulSet"},
	"daemonsets":              {"apps", "v1", "DaemonSet"},
	"pods":                    {"", "v1", "Pod"},
	"services":                {"", "v1", "Service"},
	"ingresses":               {"networking.k8s.io", "v1", "Ingress"},
	"configmaps":              {"", "v1", "ConfigMap"},
	"secrets":                 {"", "v1", "Secret"},
	"persistentvolumeclaims":  {"", "v1", "PersistentVolumeClaim"},
	"persistentvolumes":       {"", "v1", "PersistentVolume"},
}

func ListWorkloads(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		resourceType := c.Param("type")
		namespace := c.Query("namespace")
		continueToken := c.Query("continue")
		var limit int64
		if s := c.Query("limit"); s != "" {
			if v, err := strconv.ParseInt(s, 10, 64); err == nil && v > 0 {
				limit = v
			}
		}

		gvk, ok := resourceGVK[resourceType]
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), workerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list",
			Group:         gvk.group,
			Version:       gvk.version,
			Kind:          gvk.kind,
			Namespace:     namespace,
			Limit:         limit,
			ContinueToken: continueToken,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}

		// Pass raw K8s JSON through — frontend parses it.
		c.Data(http.StatusOK, "application/json", resp.Data)
	}
}

func GetWorkload(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		resourceType := c.Param("type")
		name := c.Param("name")
		namespace := c.Query("namespace")

		gvk, ok := resourceGVK[resourceType]
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), workerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:    "get",
			Group:     gvk.group,
			Version:   gvk.version,
			Kind:      gvk.kind,
			Namespace: namespace,
			Name:      name,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}
		c.Data(http.StatusOK, "application/json", resp.Data)
	}
}

func ApplyWorkload(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		resourceType := c.Param("type")
		name := c.Param("name")
		namespace := c.Query("namespace")

		gvk, ok := resourceGVK[resourceType]
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		if strings.HasPrefix(namespace, "kube-") {
			apiErr(c, http.StatusForbidden, CodeNamespaceProtected)
			return
		}

		body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxBodySize))
		if err != nil || len(body) == 0 {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), workerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:    "apply",
			Group:     gvk.group,
			Version:   gvk.version,
			Kind:      gvk.kind,
			Namespace: namespace,
			Name:      name,
			Body:      body,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}
		c.Data(http.StatusOK, "application/json", resp.Data)
	}
}

// ApplyYAML accepts a raw single-document YAML manifest (text/* or JSON), parses
// it to extract GVK + metadata, and routes to the same Server-Side Apply path
// as the per-type ApplyWorkload handler. Single-doc only for now — multi-doc
// `---` separated files need a follow-up commit (would have to apply each in
// a transaction-ish way and report partial failures).
func ApplyYAML(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")

		body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxBodySize))
		if err != nil || len(body) == 0 {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		// sigs.k8s.io/yaml handles both YAML and JSON input — converts to JSON.
		jsonBody, err := sigsyaml.YAMLToJSON(body)
		if err != nil {
			apiErrWorker(c, "invalid YAML: "+err.Error())
			return
		}

		obj := &unstructured.Unstructured{}
		if err := obj.UnmarshalJSON(jsonBody); err != nil {
			apiErrWorker(c, "invalid manifest: "+err.Error())
			return
		}

		gvk := obj.GroupVersionKind()
		if gvk.Kind == "" || gvk.Version == "" {
			apiErrWorker(c, "manifest missing apiVersion or kind")
			return
		}
		name := obj.GetName()
		if name == "" {
			apiErrWorker(c, "manifest missing metadata.name")
			return
		}
		namespace := obj.GetNamespace()

		if strings.HasPrefix(namespace, "kube-") {
			apiErr(c, http.StatusForbidden, CodeNamespaceProtected)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), workerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:    "apply",
			Group:     gvk.Group,
			Version:   gvk.Version,
			Kind:      gvk.Kind,
			Namespace: namespace,
			Name:      name,
			Body:      jsonBody,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}
		c.Data(http.StatusOK, "application/json", resp.Data)
	}
}

func DeleteWorkload(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		resourceType := c.Param("type")
		name := c.Param("name")
		namespace := c.Query("namespace")

		gvk, ok := resourceGVK[resourceType]
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		if strings.HasPrefix(namespace, "kube-") {
			apiErr(c, http.StatusForbidden, CodeNamespaceProtected)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), workerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:    "delete",
			Group:     gvk.group,
			Version:   gvk.version,
			Kind:      gvk.kind,
			Namespace: namespace,
			Name:      name,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}
		c.JSON(http.StatusOK, gin.H{})
	}
}

func ListNamespaces(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")

		ctx, cancel := context.WithTimeout(c.Request.Context(), workerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:  "list",
			Version: "v1",
			Kind:    "Namespace",
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}

		// Extract names from K8s Table API response (rows[].object.metadata.name).
		var raw struct {
			Rows []struct {
				Object struct {
					Metadata struct {
						Name string `json:"name"`
					} `json:"metadata"`
				} `json:"object"`
			} `json:"rows"`
		}
		if err := json.Unmarshal(resp.Data, &raw); err != nil {
			apiErrInternal(c, err)
			return
		}
		names := make([]string, 0, len(raw.Rows))
		for _, row := range raw.Rows {
			if n := row.Object.Metadata.Name; n != "" {
				names = append(names, n)
			}
		}
		c.JSON(http.StatusOK, names)
	}
}

func handleWorkerErr(c *gin.Context, err error) {
	if errors.Is(err, context.DeadlineExceeded) {
		apiErr(c, http.StatusGatewayTimeout, CodeWorkerTimeout)
		return
	}
	// "cluster X not connected" — worker is offline
	apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
}
