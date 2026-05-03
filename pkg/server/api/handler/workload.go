package handler

import (
	"bytes"
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
	apimacyaml "k8s.io/apimachinery/pkg/util/yaml"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

const workerTimeout = 30 * time.Second
const maxBodySize = 1 << 20 // 1 MB — sufficient for any K8s manifest

// protectedNamespacePrefixes lists namespace name prefixes whose
// resources are read-only via the Workloads UI. The frontend hides
// edit/delete buttons for these and the backend rejects writes with
// 403 / NAMESPACE_PROTECTED.
//
// `kube-*` covers control-plane namespaces (kube-system, kube-public,
// kube-node-lease). `kpilot-*` protects the namespaces our built-in
// plugins install into (kpilot-monitoring, kpilot-logging, kpilot-gpu)
// so users don't accidentally `kubectl delete deployment` the
// VictoriaMetrics pod from the workload list.
var protectedNamespacePrefixes = []string{"kube-", "kpilot-"}

func isProtectedNamespace(ns string) bool {
	for _, p := range protectedNamespacePrefixes {
		if strings.HasPrefix(ns, p) {
			return true
		}
	}
	return false
}

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

// ApplyWorkload is the per-row "Edit YAML" save path. Despite the name,
// it sends the worker an `update` (PUT) action — kubectl-edit semantics:
// the body's resourceVersion is checked by K8s, concurrent edits surface
// as 409 instead of one user silently overwriting the other.
//
// The Apply YAML drawer (multi-doc upload) goes through ApplyYAML below,
// which uses the SSA `apply` action — that one's `kubectl apply`
// semantics, no resourceVersion required.
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

		if isProtectedNamespace(namespace) {
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
			Action:    "update",
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
			// K8s' optimistic-concurrency error from a stale
			// resourceVersion comes back as a string from worker.
			// Translate to a typed code so the frontend can render
			// "resource has been modified, please reload" instead of
			// the bare K8s message.
			if isConflictMessage(resp.Error) {
				apiErr(c, http.StatusConflict, CodeWorkerConflict)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}
		c.Data(http.StatusOK, "application/json", resp.Data)
	}
}

// isConflictMessage matches K8s' optimistic-concurrency rejection on
// stale resourceVersion. The wire-level error is a structured Status,
// but worker flattens it to a string before sending — we sniff for the
// distinctive substring rather than re-marshalling on Server.
func isConflictMessage(s string) bool {
	return strings.Contains(s, "the object has been modified")
}

// ApplyYamlResult is one entry in the response array; one per parsed document.
type ApplyYamlResult struct {
	Index     int    `json:"index"`
	Kind      string `json:"kind,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name,omitempty"`
	Success   bool   `json:"success"`
	Error     string `json:"error,omitempty"`
}

// ApplyYAML accepts raw YAML/JSON (single document or `---` separated multi-
// document) and applies each entry through the same Server-Side Apply path
// as ApplyWorkload. Returns a 200 with per-document results — the frontend
// inspects `success` per entry to decide success / partial / total failure.
//
// Apply is fail-soft (continue past errors) so users can recover from a
// partially-bad manifest without re-uploading; ordering is preserved so
// dependency-style manifests (e.g. namespace before deployment) work as
// long as the user authored them in order.
func ApplyYAML(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")

		body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxBodySize))
		if err != nil || len(body) == 0 {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		docs, parseErr := parseYAMLDocs(body)
		if parseErr != nil {
			apiErrWorker(c, "invalid YAML: "+parseErr.Error())
			return
		}
		if len(docs) == 0 {
			apiErrWorker(c, "no manifests found")
			return
		}

		results := make([]ApplyYamlResult, 0, len(docs))
		for i, obj := range docs {
			results = append(results, applyOneDoc(c.Request.Context(), gw, clusterID, i, obj))
		}
		c.JSON(http.StatusOK, gin.H{"results": results})
	}
}

// parseYAMLDocs decodes a (possibly multi-document) YAML/JSON stream into a
// slice of unstructured manifests, skipping empty documents (e.g. trailing
// `---` or comment-only blocks).
func parseYAMLDocs(body []byte) ([]*unstructured.Unstructured, error) {
	dec := apimacyaml.NewYAMLOrJSONDecoder(bytes.NewReader(body), 4096)
	var out []*unstructured.Unstructured
	for {
		obj := &unstructured.Unstructured{}
		if err := dec.Decode(obj); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
		if len(obj.Object) == 0 {
			continue
		}
		out = append(out, obj)
	}
	return out, nil
}

func applyOneDoc(ctx context.Context, gw *gateway.GatewayServer, clusterID string, idx int, obj *unstructured.Unstructured) ApplyYamlResult {
	gvk := obj.GroupVersionKind()
	r := ApplyYamlResult{
		Index:     idx,
		Kind:      gvk.Kind,
		Namespace: obj.GetNamespace(),
		Name:      obj.GetName(),
	}

	if gvk.Kind == "" || gvk.Version == "" {
		r.Error = "missing apiVersion or kind"
		return r
	}
	if r.Name == "" {
		r.Error = "missing metadata.name"
		return r
	}
	if isProtectedNamespace(r.Namespace) {
		r.Error = "namespace " + r.Namespace + " is read-only"
		return r
	}

	jsonBody, err := obj.MarshalJSON()
	if err != nil {
		r.Error = err.Error()
		return r
	}

	cctx, cancel := context.WithTimeout(ctx, workerTimeout)
	defer cancel()

	resp, err := gw.SendResourceRequest(cctx, clusterID, &proto.ResourceRequest{
		Action:    "apply",
		Group:     gvk.Group,
		Version:   gvk.Version,
		Kind:      gvk.Kind,
		Namespace: r.Namespace,
		Name:      r.Name,
		Body:      jsonBody,
	})
	if err != nil {
		r.Error = err.Error()
		return r
	}
	if !resp.Success {
		r.Error = resp.Error
		return r
	}
	r.Success = true
	return r
}

// DescribeWorkload returns the kubectl-equivalent describe output as plain
// text. The Worker delegates to k8s.io/kubectl/pkg/describe so the format
// matches `kubectl describe` 1:1, including the events block.
func DescribeWorkload(gw *gateway.GatewayServer) gin.HandlerFunc {
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
			Action:    "describe",
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
		c.Data(http.StatusOK, "text/plain; charset=utf-8", resp.Data)
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

		if isProtectedNamespace(namespace) {
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
