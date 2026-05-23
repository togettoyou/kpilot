package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	apimacyaml "k8s.io/apimachinery/pkg/util/yaml"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// writeWorkerTimeout caps mutating requests (apply / delete / patch /
// cordon). 30s matches the worker-side write timeout — both ends give
// up at the same point so a stuck admission webhook surfaces as a
// clean error instead of leaving the client hanging.
//
// readWorkerTimeout is more generous for read paths (list / get /
// describe / list-full). The worker proxy uses 120s for these too;
// keeping the server in lock-step prevents the server from cancelling
// an in-progress worker fetch on a busy cluster (large describe, big
// CR list) before the worker can answer.
const (
	writeWorkerTimeout = 30 * time.Second
	readWorkerTimeout  = 120 * time.Second
)
const maxBodySize = 1 << 20 // 1 MB — sufficient for any K8s manifest

// workloadListCap is the hard ceiling on the per-request K8s list size
// that the generic CR list path will pass to the worker. Matches the
// Volcano list endpoints' defaultVolcanoListLimit (500) so the entire
// list surface has the same upper bound. Without this cap, a hostile
// `?limit=10000000` query would have the worker streaming back a list
// large enough to blow past the 32 MiB gRPC message ceiling.
const workloadListCap int64 = 500

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
	// Cluster-scoped Node — used by the dedicated /nodes UI page (which
	// calls /workloads/nodes under the hood). Listing through the
	// workloads proxy gives us kubectl-default + wide columns from the
	// Table API for free; no node menu entry under 工作负载 / 网络 / 存储
	// (the dedicated Nodes sider link covers it).
	"nodes":                    {"", "v1", "Node"},
	"deployments":              {"apps", "v1", "Deployment"},
	"statefulsets":             {"apps", "v1", "StatefulSet"},
	"daemonsets":               {"apps", "v1", "DaemonSet"},
	"replicasets":              {"apps", "v1", "ReplicaSet"},
	"pods":                     {"", "v1", "Pod"},
	"jobs":                     {"batch", "v1", "Job"},
	"cronjobs":                 {"batch", "v1", "CronJob"},
	"horizontalpodautoscalers": {"autoscaling", "v2", "HorizontalPodAutoscaler"},
	"services":                 {"", "v1", "Service"},
	"endpointslices":           {"discovery.k8s.io", "v1", "EndpointSlice"},
	"ingresses":                {"networking.k8s.io", "v1", "Ingress"},
	"networkpolicies":          {"networking.k8s.io", "v1", "NetworkPolicy"},
	"gatewayclasses":           {"gateway.networking.k8s.io", "v1", "GatewayClass"},
	"gateways":                 {"gateway.networking.k8s.io", "v1", "Gateway"},
	"httproutes":               {"gateway.networking.k8s.io", "v1", "HTTPRoute"},
	"grpcroutes":               {"gateway.networking.k8s.io", "v1", "GRPCRoute"},
	"configmaps":               {"", "v1", "ConfigMap"},
	"secrets":                  {"", "v1", "Secret"},
	"persistentvolumeclaims":   {"", "v1", "PersistentVolumeClaim"},
	"persistentvolumes":        {"", "v1", "PersistentVolume"},
	"storageclasses":           {"storage.k8s.io", "v1", "StorageClass"},
	// RBAC
	"serviceaccounts":     {"", "v1", "ServiceAccount"},
	"roles":               {"rbac.authorization.k8s.io", "v1", "Role"},
	"rolebindings":        {"rbac.authorization.k8s.io", "v1", "RoleBinding"},
	"clusterroles":        {"rbac.authorization.k8s.io", "v1", "ClusterRole"},
	"clusterrolebindings": {"rbac.authorization.k8s.io", "v1", "ClusterRoleBinding"},
	// Policy / scheduling — quota + disruption + priority
	"resourcequotas":       {"", "v1", "ResourceQuota"},
	"limitranges":          {"", "v1", "LimitRange"},
	"poddisruptionbudgets": {"policy", "v1", "PodDisruptionBudget"},
	"priorityclasses":      {"scheduling.k8s.io", "v1", "PriorityClass"},
	"runtimeclasses":       {"node.k8s.io", "v1", "RuntimeClass"},
	// Admission control — webhook configs + ValidatingAdmissionPolicy
	// (GA since K8s 1.30). Older clusters return "no matches for kind"
	// on the policy types; same graceful degradation as DRA.
	"validatingwebhookconfigurations": {"admissionregistration.k8s.io", "v1", "ValidatingWebhookConfiguration"},
	"mutatingwebhookconfigurations":   {"admissionregistration.k8s.io", "v1", "MutatingWebhookConfiguration"},
	"validatingadmissionpolicies":     {"admissionregistration.k8s.io", "v1", "ValidatingAdmissionPolicy"},
	// MutatingAdmissionPolicy — alpha since K8s 1.32 under
	// `MutatingAdmissionPolicy` feature gate. Pinned to v1alpha1; on
	// clusters without the gate enabled the request hits "no matches
	// for kind" and the page surfaces it as a worker error (same path
	// Gateway API / DRA take when their CRDs aren't installed).
	"mutatingadmissionpolicies": {"admissionregistration.k8s.io", "v1alpha1", "MutatingAdmissionPolicy"},
	// Dynamic Resource Allocation (resource.k8s.io). Pinned to v1 (GA
	// since K8s 1.34, Aug 2025). v1beta1 was tried first but several
	// distros disable beta versions even on 1.34+, so the RESTMapper
	// returns "no matches for kind" — v1 is the safer default. Older
	// 1.32-1.33 clusters that only have v1beta1 will see the same
	// "no matches" error; that's the same graceful-degradation path
	// the Gateway API kinds take when those CRDs aren't installed.
	"resourceclaims":         {"resource.k8s.io", "v1", "ResourceClaim"},
	"resourceclaimtemplates": {"resource.k8s.io", "v1", "ResourceClaimTemplate"},
	"deviceclasses":          {"resource.k8s.io", "v1", "DeviceClass"},
	"resourceslices":         {"resource.k8s.io", "v1", "ResourceSlice"},
	// API extensions group — exposed under the "扩展" submenu rather
	// than "工作负载" since these are API-shape resources, not pods.
	"customresourcedefinitions": {"apiextensions.k8s.io", "v1", "CustomResourceDefinition"},
}

// resolveGVK looks up the request's GVK. Two paths:
//
//   - Well-known kinds (Deployment, Service, …) come from the
//     resourceGVK whitelist, keyed by URL `:type` segment.
//   - The `_cr` sentinel `:type` says "look at query params" — the
//     CR-instances viewer uses this to browse CRs of any user-installed
//     CRD without us hardcoding the GVK. Worker resolves the
//     resource side via its dynamic RESTMapper, so we just pass
//     group/version/kind through.
func resolveGVK(c *gin.Context) (gvkInfo, bool) {
	rt := c.Param("type")
	if rt == "_cr" {
		v := c.Query("version")
		k := c.Query("kind")
		if v == "" || k == "" {
			return gvkInfo{}, false
		}
		return gvkInfo{group: c.Query("group"), version: v, kind: k}, true
	}
	gvk, ok := resourceGVK[rt]
	return gvk, ok
}

func ListWorkloads(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Query("namespace")
		continueToken := c.Query("continue")
		// Cap incoming limit. Without the cap, a malicious client can
		// request `limit=10000000` and the worker streams back a huge
		// list that easily exceeds the 32 MiB gRPC message ceiling —
		// the resulting ResourceExhausted abort leaves the request
		// dangling and pins server memory until GC. Default and cap
		// both = workloadListCap, matching the Volcano list endpoints.
		var limit int64 = workloadListCap
		if s := c.Query("limit"); s != "" {
			if v, err := strconv.ParseInt(s, 10, 64); err == nil && v > 0 && v < workloadListCap {
				limit = v
			}
		}

		gvk, ok := resolveGVK(c)
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
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
			if isNoMatchMessage(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
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

		gvk, ok := resolveGVK(c)
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
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
			if isNoMatchMessage(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
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

		gvk, ok := resolveGVK(c)
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxBodySize))
		if err != nil || len(body) == 0 {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), writeWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
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
			if isNoMatchMessage(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
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

// isNoMatchMessage detects errors meaning "the GVK isn't available
// on this cluster" — translated into a dedicated 404 /
// RESOURCE_NOT_AVAILABLE so the frontend can render a friendly
// "feature not enabled" placeholder instead of the generic
// worker-error toast.
//
// Two phrasings show up in practice:
//
//  1. RESTMapper failure: "no matches for kind \"X\" in version \"Y\"" —
//     raised before any API call when client-go can't even find the
//     GVK in the discovery cache. Typical when the CRD was never
//     installed, or a feature gate (DRA, MutatingAdmissionPolicy) is
//     off.
//
//  2. API server 404: "the server could not find the requested
//     resource" — raised by the API server itself, returned through
//     client-go's dynamic interface. Hits when the CRD was just
//     uninstalled (Helm uninstall keeps the CRD by default, but the
//     controller-manager going away or a fresh `kubectl delete crd`
//     produces this), or when worker's RESTMapper cache is stale
//     and points at a GVK that no longer serves.
func isNoMatchMessage(s string) bool {
	return strings.Contains(s, "no matches for kind") ||
		strings.Contains(s, "could not find the requested resource")
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

// validateDoc populates ApplyYamlResult.{Index,Kind,Namespace,Name}
// from the unstructured object and runs the basic shape guards
// (apiVersion / kind / metadata.name present). Returns (result, ok)
// — when ok is false the caller appends the result directly with
// its .Error field filled in.
func validateDoc(
	idx int,
	obj *unstructured.Unstructured,
) (ApplyYamlResult, bool) {
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

	cctx, cancel := context.WithTimeout(ctx, writeWorkerTimeout)
	defer cancel()

	resp, err := gw.SendResourceRequest(cctx, clusterID, &gateway.ResourceRequest{
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

	cctx, cancel := context.WithTimeout(ctx, writeWorkerTimeout)
	defer cancel()

	resp, err := gw.SendResourceRequest(cctx, clusterID, &gateway.ResourceRequest{
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

		gvk, ok := resolveGVK(c)
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
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
			if isNoMatchMessage(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
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

		gvk, ok := resolveGVK(c)
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), writeWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
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
			if isNoMatchMessage(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}
		c.JSON(http.StatusOK, gin.H{})
	}
}

func ListNamespaces(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")

		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action:  "list",
			Version: "v1",
			Kind:    "Namespace",
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
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

// CordonNode toggles spec.unschedulable on a Node via Strategic Merge
// Patch. The patch payload is constructed server-side from a single
// boolean — the client can't smuggle in extra fields, even if the
// request body has more keys, this handler ignores them. Paired with
// the no-generic-write guard in ApplyWorkload / DeleteWorkload above
// so the only way to mutate a Node is this endpoint (or admin-side
// kubectl, which is out of scope for the UI).
func CordonNode(gw *gateway.GatewayServer) gin.HandlerFunc {
	type body struct {
		Cordon bool `json:"cordon"`
	}
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		name := c.Param("name")
		if name == "" {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		var req body
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		// Server constructs the patch — never accept a raw patch body
		// from the client. This is the whole reason we don't reuse the
		// generic update path.
		patch, err := json.Marshal(map[string]any{
			"spec": map[string]any{
				"unschedulable": req.Cordon,
			},
		})
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), writeWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action:  "patch",
			Group:   "",
			Version: "v1",
			Kind:    "Node",
			Name:    name,
			Body:    patch,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}
		c.Data(http.StatusOK, "application/json", resp.Data)
	}
}

// scopedAction sends a server-constructed strategic merge patch to a
// specific resource — same posture as CordonNode (the client picks
// the verb, the server picks the patch body, raw spec patches stay
// disallowed). Used for the rollout / scale / pause / resume
// shortcuts where giving the client a generic patch endpoint would
// re-open the surface area we removed in P12 when protect/ was
// retired.
//
// `allowed` restricts which URL resource-types this verb applies to
// (e.g. rollout-restart works on Deployment/StatefulSet/DaemonSet
// but not on Pods).
func scopedAction(
	gw *gateway.GatewayServer,
	allowed map[string]struct{},
	buildPatch func(c *gin.Context) ([]byte, bool),
) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		resourceType := c.Param("type")
		name := c.Param("name")
		namespace := c.Query("namespace")
		if clusterID == "" || name == "" {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if _, ok := allowed[resourceType]; !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		gvk, ok := resourceGVK[resourceType]
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		patch, ok := buildPatch(c)
		if !ok {
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), writeWorkerTimeout)
		defer cancel()
		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action:    "patch",
			Group:     gvk.group,
			Version:   gvk.version,
			Kind:      gvk.kind,
			Namespace: namespace,
			Name:      name,
			Body:      patch,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}
		c.Data(http.StatusOK, "application/json", resp.Data)
	}
}

// RolloutRestart triggers a rolling restart of a Deployment /
// StatefulSet / DaemonSet by stamping the canonical
// `kubectl.kubernetes.io/restartedAt: <RFC3339 now>` annotation on
// `spec.template.metadata.annotations`. This forces the workload
// controller to detect a template hash change and recreate Pods
// one by one with the normal rolling-update strategy — same
// mechanism `kubectl rollout restart` uses.
func RolloutRestart(gw *gateway.GatewayServer) gin.HandlerFunc {
	allowed := map[string]struct{}{
		"deployments":  {},
		"statefulsets": {},
		"daemonsets":   {},
	}
	return scopedAction(gw, allowed, func(c *gin.Context) ([]byte, bool) {
		now := time.Now().UTC().Format(time.RFC3339)
		patch, err := json.Marshal(map[string]any{
			"spec": map[string]any{
				"template": map[string]any{
					"metadata": map[string]any{
						"annotations": map[string]any{
							"kubectl.kubernetes.io/restartedAt": now,
						},
					},
				},
			},
		})
		if err != nil {
			apiErrInternal(c, err)
			return nil, false
		}
		return patch, true
	})
}

// RolloutPause / RolloutResume toggle Deployment.spec.paused.
// Pause is Deployment-only — StatefulSet / DaemonSet don't expose
// a paused field. While paused, edits to the Deployment don't
// trigger a new rollout; useful for canary / staged config rollouts.
func RolloutPause(gw *gateway.GatewayServer) gin.HandlerFunc {
	return rolloutPaused(gw, true)
}

func RolloutResume(gw *gateway.GatewayServer) gin.HandlerFunc {
	return rolloutPaused(gw, false)
}

func rolloutPaused(gw *gateway.GatewayServer, paused bool) gin.HandlerFunc {
	allowed := map[string]struct{}{"deployments": {}}
	return scopedAction(gw, allowed, func(c *gin.Context) ([]byte, bool) {
		patch, err := json.Marshal(map[string]any{
			"spec": map[string]any{"paused": paused},
		})
		if err != nil {
			apiErrInternal(c, err)
			return nil, false
		}
		return patch, true
	})
}

// Scale sets `spec.replicas` on a Deployment / StatefulSet /
// ReplicaSet. Equivalent to `kubectl scale --replicas=N`. We
// patch the main object's spec.replicas instead of the /scale
// subresource — controllers pick up either; the dynamic client's
// subresource path needs more plumbing for marginal benefit.
//
// DaemonSet is excluded — its replica count is governed by the
// node selector, not a knob.
//
// Range cap (0..1000) is defensive against accidental fat-finger.
func Scale(gw *gateway.GatewayServer) gin.HandlerFunc {
	allowed := map[string]struct{}{
		"deployments":  {},
		"statefulsets": {},
		"replicasets":  {},
	}
	return scopedAction(gw, allowed, func(c *gin.Context) ([]byte, bool) {
		var body struct {
			Replicas *int32 `json:"replicas"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || body.Replicas == nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return nil, false
		}
		if *body.Replicas < 0 || *body.Replicas > 1000 {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return nil, false
		}
		patch, err := json.Marshal(map[string]any{
			"spec": map[string]any{"replicas": *body.Replicas},
		})
		if err != nil {
			apiErrInternal(c, err)
			return nil, false
		}
		return patch, true
	})
}

// ─── rollout history + undo ───────────────────────────────────────
//
// kubectl rollout history / undo are implemented entirely server-
// side by composing existing worker actions (no new wire types
// needed). The Deployment owns N ReplicaSets — one per revision —
// linked via metadata.ownerReferences + annotated with
// `deployment.kubernetes.io/revision`. We GET the deployment for
// its UID, list ReplicaSets in the same namespace, filter by
// ownerRef.uid == deployment.uid, sort by revision, and project
// to a slim shape for the UI.
//
// Undo: same list, find target (default = previous), strip the
// pod-template-hash label that the controller adds (otherwise the
// new ReplicaSet would have the SAME hash as the rollback target,
// and the controller wouldn't generate a new replica), patch the
// Deployment's spec.template back with the cleaned version.

// rolloutAllowedTypes — which URL :type values support history/undo.
// Only Deployment for now; StatefulSet's revision history works
// differently (ControllerRevisions, not ReplicaSets) and would need
// a separate code path.
var rolloutAllowedTypes = map[string]struct{}{"deployments": {}}

// RolloutHistoryEntry is the JSON shape returned to the UI. Field
// names mirror kubectl rollout history columns where possible.
type RolloutHistoryEntry struct {
	Revision         int64             `json:"revision"`
	Name             string            `json:"name"`              // ReplicaSet name
	Replicas         int32             `json:"replicas"`          // .spec.replicas
	ReadyReplicas    int32             `json:"readyReplicas"`     // .status.readyReplicas
	Image            string            `json:"image,omitempty"`   // first container's image, convenience
	CreatedAt        string            `json:"createdAt"`         // metadata.creationTimestamp
	ChangeCause      string            `json:"changeCause,omitempty"` // kubectl.kubernetes.io/change-cause
	PodTemplateHash  string            `json:"podTemplateHash,omitempty"`
	Annotations      map[string]string `json:"annotations,omitempty"`
	Current          bool              `json:"current"` // true if this RS matches Deployment's current pod-template-hash
}

// RolloutHistory lists past revisions of a Deployment. Sorted by
// revision descending (newest first) — kubectl prints oldest first,
// but UI tables usually want newest-on-top.
func RolloutHistory(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		resourceType := c.Param("type")
		name := c.Param("name")
		namespace := c.Query("namespace")
		if clusterID == "" || name == "" || namespace == "" {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if _, ok := rolloutAllowedTypes[resourceType]; !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		dep, replicasets, err := fetchRolloutSet(ctx, gw, clusterID, namespace, name)
		if err != nil {
			handleRolloutErr(c, err)
			return
		}

		entries := projectRolloutEntries(dep, replicasets)
		c.JSON(http.StatusOK, map[string]any{"revisions": entries})
	}
}

// RolloutUndo rolls a Deployment back to a previous revision. Body:
// `{"toRevision": N}` — when omitted or 0, rolls back to the most
// recent prior revision (kubectl default).
func RolloutUndo(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		resourceType := c.Param("type")
		name := c.Param("name")
		namespace := c.Query("namespace")
		if clusterID == "" || name == "" || namespace == "" {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if _, ok := rolloutAllowedTypes[resourceType]; !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		var body struct {
			ToRevision int64 `json:"toRevision"`
		}
		_ = c.ShouldBindJSON(&body) // empty body OK → ToRevision=0 → previous

		ctx, cancel := context.WithTimeout(c.Request.Context(), writeWorkerTimeout)
		defer cancel()

		dep, replicasets, err := fetchRolloutSet(ctx, gw, clusterID, namespace, name)
		if err != nil {
			handleRolloutErr(c, err)
			return
		}

		entries := projectRolloutEntries(dep, replicasets)
		if len(entries) < 2 {
			apiErrDetail(c, http.StatusBadRequest, CodeInvalidRequest,
				"no previous revision to roll back to")
			return
		}

		var target *unstructured.Unstructured
		var targetRev int64
		if body.ToRevision > 0 {
			// Find specific revision in the unsorted ReplicaSet list.
			for i := range replicasets {
				rs := &replicasets[i]
				if revisionOf(rs) == body.ToRevision {
					target = rs
					targetRev = body.ToRevision
					break
				}
			}
			if target == nil {
				apiErrDetail(c, http.StatusNotFound, CodeResourceNotAvailable,
					"requested revision not found")
				return
			}
		} else {
			// Default: previous = entries[1] (entries sorted newest-first).
			targetRev = entries[1].Revision
			for i := range replicasets {
				rs := &replicasets[i]
				if revisionOf(rs) == targetRev {
					target = rs
					break
				}
			}
			if target == nil {
				apiErrInternal(c, errors.New("could not resolve previous revision"))
				return
			}
		}

		// Already at the target? No-op.
		currentRev := revisionOf(dep)
		if currentRev == targetRev {
			c.JSON(http.StatusOK, map[string]any{
				"rolledBackTo": targetRev,
				"noop":         true,
			})
			return
		}

		// Take the target ReplicaSet's spec.template, strip the
		// `pod-template-hash` label the controller injects. Without
		// stripping, the patched Deployment would end up with a Pod
		// template whose hash matches an existing ReplicaSet, and
		// the controller wouldn't generate a fresh one.
		template, ok, err := unstructured.NestedMap(target.Object, "spec", "template")
		if err != nil || !ok {
			apiErrInternal(c, errors.New("target ReplicaSet missing spec.template"))
			return
		}
		stripPodTemplateHash(template)

		patch, err := json.Marshal(map[string]any{
			"spec": map[string]any{
				"template": template,
			},
		})
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action:    "patch",
			Group:     "apps",
			Version:   "v1",
			Kind:      "Deployment",
			Namespace: namespace,
			Name:      name,
			Body:      patch,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}
		c.JSON(http.StatusOK, map[string]any{
			"rolledBackTo": targetRev,
			"noop":         false,
		})
	}
}

// fetchRolloutSet gets the Deployment and lists ReplicaSets in its
// namespace, filtered to ones owned by this Deployment.
func fetchRolloutSet(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID, namespace, name string,
) (*unstructured.Unstructured, []unstructured.Unstructured, error) {
	depResp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
		Action: "get", Group: "apps", Version: "v1", Kind: "Deployment",
		Namespace: namespace, Name: name,
	})
	if err != nil {
		return nil, nil, err
	}
	if !depResp.Success {
		return nil, nil, fmt.Errorf("get deployment: %s", depResp.Error)
	}
	var dep unstructured.Unstructured
	if err := dep.UnmarshalJSON(depResp.Data); err != nil {
		return nil, nil, fmt.Errorf("decode deployment: %w", err)
	}

	// Match the Deployment's spec.selector.matchLabels — same approach
	// the controller uses, and faster than list-then-filter-by-ownerRef
	// on big namespaces.
	matchLabels, found, _ := unstructured.NestedStringMap(dep.Object, "spec", "selector", "matchLabels")
	var labelSelector string
	if found && len(matchLabels) > 0 {
		parts := make([]string, 0, len(matchLabels))
		for k, v := range matchLabels {
			parts = append(parts, fmt.Sprintf("%s=%s", k, v))
		}
		labelSelector = strings.Join(parts, ",")
	}

	rsResp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
		Action: "list-full", Group: "apps", Version: "v1", Kind: "ReplicaSet",
		Namespace:     namespace,
		LabelSelector: labelSelector,
		Limit:         500,
	})
	if err != nil {
		return nil, nil, err
	}
	if !rsResp.Success {
		return nil, nil, fmt.Errorf("list replicasets: %s", rsResp.Error)
	}
	var rsList unstructured.UnstructuredList
	if err := rsList.UnmarshalJSON(rsResp.Data); err != nil {
		return nil, nil, fmt.Errorf("decode replicasets: %w", err)
	}

	// Filter by ownerRef.uid — label-selector match alone could pick
	// up ReplicaSets created by a Deployment that was deleted + a new
	// one created with the same selector. UID is precise.
	depUID := dep.GetUID()
	owned := make([]unstructured.Unstructured, 0, len(rsList.Items))
	for _, rs := range rsList.Items {
		for _, or := range rs.GetOwnerReferences() {
			if or.UID == depUID && or.Kind == "Deployment" {
				owned = append(owned, rs)
				break
			}
		}
	}
	return &dep, owned, nil
}

// projectRolloutEntries flattens ReplicaSets into the wire shape,
// sorted newest-first by revision annotation.
func projectRolloutEntries(
	dep *unstructured.Unstructured,
	replicasets []unstructured.Unstructured,
) []RolloutHistoryEntry {
	currentHash, _, _ := unstructured.NestedString(dep.Object,
		"metadata", "labels", "pod-template-hash")
	// Deployment doesn't usually carry pod-template-hash; the live one
	// matches whichever ReplicaSet has spec.replicas > 0 (the active
	// one). Use revision number for the "current" flag instead.
	currentRev := revisionOf(dep)

	entries := make([]RolloutHistoryEntry, 0, len(replicasets))
	for i := range replicasets {
		rs := &replicasets[i]
		entry := RolloutHistoryEntry{
			Revision:    revisionOf(rs),
			Name:        rs.GetName(),
			CreatedAt:   rs.GetCreationTimestamp().UTC().Format(time.RFC3339),
			ChangeCause: rs.GetAnnotations()["kubectl.kubernetes.io/change-cause"],
		}
		entry.PodTemplateHash, _, _ = unstructured.NestedString(rs.Object,
			"metadata", "labels", "pod-template-hash")
		if rep, found, _ := unstructured.NestedInt64(rs.Object, "spec", "replicas"); found {
			entry.Replicas = int32(rep)
		}
		if ready, found, _ := unstructured.NestedInt64(rs.Object, "status", "readyReplicas"); found {
			entry.ReadyReplicas = int32(ready)
		}
		// First container's image — convenience for the UI table.
		if containers, found, _ := unstructured.NestedSlice(rs.Object,
			"spec", "template", "spec", "containers"); found && len(containers) > 0 {
			if c0, ok := containers[0].(map[string]any); ok {
				if img, ok := c0["image"].(string); ok {
					entry.Image = img
				}
			}
		}
		entry.Current = entry.Revision == currentRev
		_ = currentHash
		entries = append(entries, entry)
	}
	// Newest first (largest revision number first).
	sortByRevisionDesc(entries)
	return entries
}

func revisionOf(obj *unstructured.Unstructured) int64 {
	s, ok := obj.GetAnnotations()["deployment.kubernetes.io/revision"]
	if !ok {
		return 0
	}
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func sortByRevisionDesc(es []RolloutHistoryEntry) {
	for i := 1; i < len(es); i++ {
		for j := i; j > 0 && es[j].Revision > es[j-1].Revision; j-- {
			es[j], es[j-1] = es[j-1], es[j]
		}
	}
}

func stripPodTemplateHash(template map[string]any) {
	meta, _ := template["metadata"].(map[string]any)
	if meta == nil {
		return
	}
	labels, _ := meta["labels"].(map[string]any)
	if labels == nil {
		return
	}
	delete(labels, "pod-template-hash")
}

func handleRolloutErr(c *gin.Context, err error) {
	if strings.Contains(err.Error(), "not connected") {
		apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
		return
	}
	apiErrInternal(c, err)
}

// ─── drain ────────────────────────────────────────────────────────
//
// `kubectl drain NODE` = cordon + evict every (non-DS, non-mirror)
// Pod on the node, respecting PDBs. We implement it as a single
// server-side orchestration:
//
//   1. Cordon node (patch spec.unschedulable=true) — sync
//   2. List pods on node (fieldSelector=spec.nodeName=NAME) — sync
//   3. For each pod: classify (skip DS/mirror), then evict (/eviction
//      subresource on worker side) — concurrent up to a small cap
//   4. Return summary (total / evicted / skipped / failed)
//
// PDB blocks come back as worker errors containing "violate the
// pod's disruption budget" — we surface them in `failed[]` so the
// UI can show "X pods blocked by PDB, retry later" rather than a
// generic 500.
//
// Bounded by writeWorkerTimeout (30s by default). A drain on a busy
// node with many pods + slow graceful shutdowns can take longer than
// that — we return what we managed in the budget, the user can
// click Drain again to continue. We do NOT block the request for
// minutes waiting on terminationGracePeriodSeconds (that's a real
// drawback vs `kubectl drain` which can wait forever; trade-off
// for not holding the worker session open).

const (
	// drainTimeout is the upper bound on the whole drain operation.
	// Longer than writeWorkerTimeout because we do many sequential
	// worker requests (cordon + list + N evicts).
	drainTimeout = 2 * time.Minute
	// drainEvictParallelism caps concurrent eviction requests to
	// avoid hammering the apiserver. 5 is a balance — enough to
	// drain a 50-pod node in ~10s, low enough that a misconfigured
	// PDB doesn't pin all our worker tunnel slots.
	drainEvictParallelism = 5
)

type drainResult struct {
	Total    int      `json:"total"`
	Evicted  int      `json:"evicted"`
	Skipped  int      `json:"skipped"`
	Failed   int      `json:"failed"`
	Failures []string `json:"failures,omitempty"` // "<ns>/<pod>: <error>"
}

// DrainNode cordons + evicts pods. Body:
//
//	{
//	  "ignoreDaemonSets": bool,       // default true; DS pods are unevictable
//	  "deleteEmptyDirData": bool,     // default false; emptyDir users skipped unless set
//	  "force": bool,                  // default false; uncontrolled pods skipped unless set
//	  "gracePeriodSeconds": int,      // default -1 = pod's own value
//	}
func DrainNode(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		nodeName := c.Param("name")
		if clusterID == "" || nodeName == "" {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		var opts struct {
			IgnoreDaemonSets   *bool `json:"ignoreDaemonSets"`
			DeleteEmptyDirData bool  `json:"deleteEmptyDirData"`
			Force              bool  `json:"force"`
			GracePeriodSeconds *int  `json:"gracePeriodSeconds"`
		}
		_ = c.ShouldBindJSON(&opts) // empty body OK; all fields optional
		ignoreDS := true
		if opts.IgnoreDaemonSets != nil {
			ignoreDS = *opts.IgnoreDaemonSets
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), drainTimeout)
		defer cancel()

		// Step 1: cordon.
		cordonPatch, _ := json.Marshal(map[string]any{
			"spec": map[string]any{"unschedulable": true},
		})
		cordonResp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action: "patch", Group: "", Version: "v1", Kind: "Node",
			Name: nodeName, Body: cordonPatch,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !cordonResp.Success {
			apiErrWorker(c, cordonResp.Error)
			return
		}

		// Step 2: list pods on node.
		// Using LabelSelector isn't right here — we need field selector
		// (spec.nodeName=NAME). Our wire shape doesn't carry that, so
		// we list ALL pods cluster-wide and filter client-side. The
		// list-full path already strips managedFields so the wire
		// payload is bounded.
		listResp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action: "list-full", Group: "", Version: "v1", Kind: "Pod",
			Namespace: "", Limit: 5000,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !listResp.Success {
			apiErrWorker(c, listResp.Error)
			return
		}
		var podList unstructured.UnstructuredList
		if err := podList.UnmarshalJSON(listResp.Data); err != nil {
			apiErrInternal(c, err)
			return
		}

		// Step 3: classify + evict.
		result := drainResult{}
		var targets []*unstructured.Unstructured
		for i := range podList.Items {
			pod := &podList.Items[i]
			nn, _, _ := unstructured.NestedString(pod.Object, "spec", "nodeName")
			if nn != nodeName {
				continue
			}
			// Skip already-terminating pods (saves an eviction call
			// for nothing).
			if pod.GetDeletionTimestamp() != nil {
				continue
			}
			result.Total++

			// Mirror pod (static pod managed by kubelet via manifest
			// file). Can't be evicted — kubelet always recreates it.
			if _, isMirror := pod.GetAnnotations()["kubernetes.io/config.mirror"]; isMirror {
				result.Skipped++
				continue
			}
			// DaemonSet-owned. kubectl drain refuses unless
			// --ignore-daemonsets; we default to ignoring (= skip).
			if ownedByDaemonSet(pod) {
				if ignoreDS {
					result.Skipped++
					continue
				}
				result.Failed++
				result.Failures = append(result.Failures,
					fmt.Sprintf("%s/%s: managed by DaemonSet (pass ignoreDaemonSets=false to fail loudly)",
						pod.GetNamespace(), pod.GetName()))
				continue
			}
			// Pod with emptyDir volume — drain refuses unless
			// --delete-emptydir-data, because the data is lost.
			if !opts.DeleteEmptyDirData && podHasEmptyDirData(pod) {
				result.Skipped++
				continue
			}
			// Uncontrolled pod (no ownerRef = bare pod). kubectl drain
			// needs --force, because the pod won't be recreated.
			if !opts.Force && len(pod.GetOwnerReferences()) == 0 {
				result.Skipped++
				continue
			}
			targets = append(targets, pod)
		}

		// Bounded-parallelism eviction loop.
		sem := make(chan struct{}, drainEvictParallelism)
		var failuresMu sync.Mutex
		var wg sync.WaitGroup
		for _, p := range targets {
			pod := p
			sem <- struct{}{}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() { <-sem }()

				var body []byte
				if opts.GracePeriodSeconds != nil && *opts.GracePeriodSeconds >= 0 {
					body, _ = json.Marshal(map[string]any{
						"apiVersion": "policy/v1",
						"kind":       "Eviction",
						"metadata": map[string]any{
							"name":      pod.GetName(),
							"namespace": pod.GetNamespace(),
						},
						"deleteOptions": map[string]any{
							"gracePeriodSeconds": *opts.GracePeriodSeconds,
						},
					})
				}
				resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
					Action: "evict", Group: "", Version: "v1", Kind: "Pod",
					Namespace: pod.GetNamespace(),
					Name:      pod.GetName(),
					Body:      body,
				})
				failuresMu.Lock()
				defer failuresMu.Unlock()
				if err != nil {
					result.Failed++
					result.Failures = append(result.Failures,
						fmt.Sprintf("%s/%s: %v", pod.GetNamespace(), pod.GetName(), err))
					return
				}
				if !resp.Success {
					// Pod already gone is fine (idempotent).
					if strings.Contains(resp.Error, "NotFound") ||
						strings.Contains(resp.Error, "not found") {
						result.Evicted++
						return
					}
					result.Failed++
					result.Failures = append(result.Failures,
						fmt.Sprintf("%s/%s: %s", pod.GetNamespace(), pod.GetName(), resp.Error))
					return
				}
				result.Evicted++
			}()
		}
		wg.Wait()

		c.JSON(http.StatusOK, result)
	}
}

func ownedByDaemonSet(pod *unstructured.Unstructured) bool {
	for _, or := range pod.GetOwnerReferences() {
		if or.Kind == "DaemonSet" {
			return true
		}
	}
	return false
}

func podHasEmptyDirData(pod *unstructured.Unstructured) bool {
	vols, found, _ := unstructured.NestedSlice(pod.Object, "spec", "volumes")
	if !found {
		return false
	}
	for _, v := range vols {
		vm, ok := v.(map[string]any)
		if !ok {
			continue
		}
		if _, hasEmptyDir := vm["emptyDir"]; hasEmptyDir {
			return true
		}
	}
	return false
}
