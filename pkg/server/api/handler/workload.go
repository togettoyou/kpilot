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
//
// Gateway API kinds (gateway.networking.k8s.io) are conditional on the
// cluster having the upstream Gateway API CRDs installed. The worker's
// dynamic RESTMapper handles unknown kinds at request time — listing a
// Gateway page on a cluster without the CRD just yields a 404
// "no such kind", which the UI surfaces as the worker error.
var resourceGVK = map[string]gvkInfo{
	"deployments":              {"apps", "v1", "Deployment"},
	"statefulsets":             {"apps", "v1", "StatefulSet"},
	"daemonsets":               {"apps", "v1", "DaemonSet"},
	"pods":                     {"", "v1", "Pod"},
	"jobs":                     {"batch", "v1", "Job"},
	"cronjobs":                 {"batch", "v1", "CronJob"},
	"horizontalpodautoscalers": {"autoscaling", "v2", "HorizontalPodAutoscaler"},
	"services":                 {"", "v1", "Service"},
	"ingresses":                {"networking.k8s.io", "v1", "Ingress"},
	"gatewayclasses":           {"gateway.networking.k8s.io", "v1", "GatewayClass"},
	"gateways":                 {"gateway.networking.k8s.io", "v1", "Gateway"},
	"httproutes":               {"gateway.networking.k8s.io", "v1", "HTTPRoute"},
	"grpcroutes":               {"gateway.networking.k8s.io", "v1", "GRPCRoute"},
	"configmaps":               {"", "v1", "ConfigMap"},
	"secrets":                  {"", "v1", "Secret"},
	"persistentvolumeclaims":   {"", "v1", "PersistentVolumeClaim"},
	"persistentvolumes":        {"", "v1", "PersistentVolume"},
	"storageclasses":           {"storage.k8s.io", "v1", "StorageClass"},
	// Dynamic Resource Allocation (resource.k8s.io). Pinned to v1beta1
	// for max cluster compat: v1beta1 is served on K8s 1.32+ (where
	// DRA first went beta), while the v1 GA only landed in 1.34.
	// Older clusters without DRA enabled return 404 from the worker —
	// the page surfaces that as a worker error, same pattern as the
	// Gateway API kinds when those CRDs aren't installed.
	"resourceclaims":         {"resource.k8s.io", "v1beta1", "ResourceClaim"},
	"resourceclaimtemplates": {"resource.k8s.io", "v1beta1", "ResourceClaimTemplate"},
	"deviceclasses":          {"resource.k8s.io", "v1beta1", "DeviceClass"},
	"resourceslices":         {"resource.k8s.io", "v1beta1", "ResourceSlice"},
	// API extensions group — exposed under the "扩展" submenu rather
	// than "工作负载" since these are API-shape resources, not pods.
	"customresourcedefinitions": {"apiextensions.k8s.io", "v1", "CustomResourceDefinition"},
}

// isProtectedCRD returns true for CRD names that kpilot itself owns —
// deleting them via the workload UI would brick the running install
// (e.g. removing plugins.kpilot.io leaves every ClusterPlugin row
// pointing at a vanished kind, and the worker reconciler stops being
// able to Watch / Reconcile anything). The same protection applies to
// edit (Update would let a user clear schema fields and effectively
// disable the CRD without removing the row).
//
// Match by group suffix rather than name list — anything we own lands
// under *.kpilot.io, so this auto-extends as we add more kpilot CRDs.
func isProtectedCRD(name string) bool {
	return strings.HasSuffix(name, ".kpilot.io")
}

// isProtectedCRGroup returns true for API groups kpilot owns. CR
// instances under these groups (e.g. `Plugin` under `kpilot.io`) are
// reconciler-managed; users should drive them through the dedicated
// pages (Plugins, etc.) rather than poking the CR directly via the
// generic CR-instances viewer. Same defense-in-depth as
// isProtectedCRD but for instances rather than the CRD definitions.
func isProtectedCRGroup(group string) bool {
	return group == "kpilot.io" || strings.HasSuffix(group, ".kpilot.io")
}

// resolveGVK looks up the request's GVK + resource type. Two paths:
//
//   - Well-known kinds (Deployment, Service, …) come from the
//     resourceGVK whitelist, keyed by URL `:type` segment.
//   - The `_cr` sentinel `:type` says "look at query params" — the
//     CR-instances viewer uses this to browse CRs of any user-installed
//     CRD without us hardcoding the GVK. Worker resolves the
//     resource side via its dynamic RESTMapper, so we just pass
//     group/version/kind through.
//
// Returns (gvk, resourceType, ok). resourceType is the original URL
// segment ("_cr" or whatever); callers that need to gate behavior on
// kind ("customresourcedefinitions" → CRD-name protection) compare
// against resourceType, not `gvk.kind`.
func resolveGVK(c *gin.Context) (gvkInfo, string, bool) {
	rt := c.Param("type")
	if rt == "_cr" {
		v := c.Query("version")
		k := c.Query("kind")
		if v == "" || k == "" {
			return gvkInfo{}, rt, false
		}
		return gvkInfo{group: c.Query("group"), version: v, kind: k}, rt, true
	}
	gvk, ok := resourceGVK[rt]
	return gvk, rt, ok
}

func ListWorkloads(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Query("namespace")
		continueToken := c.Query("continue")
		var limit int64
		if s := c.Query("limit"); s != "" {
			if v, err := strconv.ParseInt(s, 10, 64); err == nil && v > 0 {
				limit = v
			}
		}

		gvk, _, ok := resolveGVK(c)
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
		name := c.Param("name")
		namespace := c.Query("namespace")

		gvk, _, ok := resolveGVK(c)
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
		name := c.Param("name")
		namespace := c.Query("namespace")

		gvk, resourceType, ok := resolveGVK(c)
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		if isProtectedNamespace(namespace) {
			apiErr(c, http.StatusForbidden, CodeNamespaceProtected)
			return
		}
		// kpilot-owned CRDs are read-only — editing one could clear the
		// schema and brick the corresponding controller. Same defense
		// runs in DeleteWorkload below.
		if resourceType == "customresourcedefinitions" && isProtectedCRD(name) {
			apiErr(c, http.StatusForbidden, CodeCRDProtected)
			return
		}
		// CR instances under kpilot.io groups are reconciler-managed —
		// the user should drive them through the dedicated UI (Plugins
		// page etc.), not the generic CR viewer. Reject edit/delete
		// here just like the CRD-definition guard above.
		if resourceType == "_cr" && isProtectedCRGroup(gvk.group) {
			apiErr(c, http.StatusForbidden, CodeCRDProtected)
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
	return yamlBatchHandler(gw, "apply", applyOneDoc)
}

// DeleteYAML is the inverse of ApplyYAML — same multi-doc YAML stream,
// each entry's GVK + name + namespace pulled out and passed to the
// worker's `delete` action. Same fail-soft per-doc results so the user
// can see exactly which deletions worked. The doc body itself is
// discarded after parsing — `kubectl delete -f` doesn't need spec/status,
// only metadata, and neither do we.
func DeleteYAML(gw *gateway.GatewayServer) gin.HandlerFunc {
	return yamlBatchHandler(gw, "delete", deleteOneDoc)
}

// yamlBatchHandler is the shared scaffolding for ApplyYAML / DeleteYAML —
// read body, parse multi-doc, run perDoc on each, return JSON results.
// action is only used for the top-level "no manifests" guard message.
func yamlBatchHandler(
	gw *gateway.GatewayServer,
	_ string,
	perDoc func(ctx context.Context, gw *gateway.GatewayServer, clusterID string, idx int, obj *unstructured.Unstructured) ApplyYamlResult,
) gin.HandlerFunc {
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
			results = append(results, perDoc(c.Request.Context(), gw, clusterID, i, obj))
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

// validateDoc populates ApplyYamlResult.{Index,Kind,Namespace,Name} from
// the unstructured object and runs the basic guards (kind/version present,
// name present, namespace not in the read-only kube-* / kpilot-* set).
// Returns (result, ok) — when ok is false the result already carries the
// reason in .Error and the caller should append it directly.
func validateDoc(idx int, obj *unstructured.Unstructured) (ApplyYamlResult, bool) {
	gvk := obj.GroupVersionKind()
	r := ApplyYamlResult{
		Index:     idx,
		Kind:      gvk.Kind,
		Namespace: obj.GetNamespace(),
		Name:      obj.GetName(),
	}
	if gvk.Kind == "" || gvk.Version == "" {
		r.Error = "missing apiVersion or kind"
		return r, false
	}
	if r.Name == "" {
		r.Error = "missing metadata.name"
		return r, false
	}
	if isProtectedNamespace(r.Namespace) {
		r.Error = "namespace " + r.Namespace + " is read-only"
		return r, false
	}
	// Same protection as the per-row CRD path: refuse SSA / delete on
	// kpilot-owned CRDs even if the user pasted them into the bulk
	// Apply YAML drawer.
	if r.Kind == "CustomResourceDefinition" && isProtectedCRD(r.Name) {
		r.Error = "CRD " + r.Name + " is owned by kpilot and read-only"
		return r, false
	}
	// And the same for CR instances under kpilot.io groups (Plugin etc.)
	// — the per-row apply/delete handlers reject these via the `_cr`
	// guard, so the bulk drawer needs to too or it becomes the obvious
	// bypass. obj.GroupVersionKind() reads apiVersion + kind out of
	// the unstructured doc.
	if isProtectedCRGroup(obj.GroupVersionKind().Group) {
		r.Error = r.Kind + "." + obj.GroupVersionKind().Group +
			" is owned by kpilot and read-only"
		return r, false
	}
	return r, true
}

func applyOneDoc(ctx context.Context, gw *gateway.GatewayServer, clusterID string, idx int, obj *unstructured.Unstructured) ApplyYamlResult {
	r, ok := validateDoc(idx, obj)
	if !ok {
		return r
	}
	gvk := obj.GroupVersionKind()

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

// deleteOneDoc is the per-document sibling of applyOneDoc: same shape and
// guards, but routes Action="delete" to the worker. Body is intentionally
// not sent — `kubectl delete -f` only needs the doc's identity (GVK +
// namespace + name), not its spec/status.
func deleteOneDoc(ctx context.Context, gw *gateway.GatewayServer, clusterID string, idx int, obj *unstructured.Unstructured) ApplyYamlResult {
	r, ok := validateDoc(idx, obj)
	if !ok {
		return r
	}
	gvk := obj.GroupVersionKind()

	cctx, cancel := context.WithTimeout(ctx, workerTimeout)
	defer cancel()

	resp, err := gw.SendResourceRequest(cctx, clusterID, &proto.ResourceRequest{
		Action:    "delete",
		Group:     gvk.Group,
		Version:   gvk.Version,
		Kind:      gvk.Kind,
		Namespace: r.Namespace,
		Name:      r.Name,
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
		name := c.Param("name")
		namespace := c.Query("namespace")

		gvk, _, ok := resolveGVK(c)
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
		name := c.Param("name")
		namespace := c.Query("namespace")

		gvk, resourceType, ok := resolveGVK(c)
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		if isProtectedNamespace(namespace) {
			apiErr(c, http.StatusForbidden, CodeNamespaceProtected)
			return
		}
		if resourceType == "customresourcedefinitions" && isProtectedCRD(name) {
			apiErr(c, http.StatusForbidden, CodeCRDProtected)
			return
		}
		if resourceType == "_cr" && isProtectedCRGroup(gvk.group) {
			apiErr(c, http.StatusForbidden, CodeCRDProtected)
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
