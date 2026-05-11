// Package protect centralizes the write-protection rules KPilot
// applies to user-driven Kubernetes operations (Edit YAML, Delete,
// Apply YAML batch). Rules previously lived inline as private helpers
// inside pkg/server/api/handler/workload.go; consolidating them here
// gives one place to add / change / unit-test the policy.
//
// Why a package, not a Gin middleware:
//
//   - Some gates need to GET the resource first (Helm-managed label,
//     default StorageClass annotation). Doing that in middleware adds
//     a worker round-trip BEFORE the handler ever runs the same
//     lookup it might want to do anyway, so middleware would either
//     duplicate the IO or force handlers to bypass the resolved data.
//   - The three call sites take inputs in different shapes
//     (URL params for ApplyWorkload / DeleteWorkload, parsed
//     unstructured for validateDoc). A single middleware signature
//     can't cleanly cover both.
//   - validateDoc rejects per-doc inside a multi-doc YAML batch;
//     middleware can't reject one doc and pass another in the same
//     request.
//
// The exported entry point is Check(), which classifies the request as
// either OpModify or OpDelete and returns *Err on rejection. Some
// gates apply only to one op (Node delete is blocked but edit is
// allowed so users can label / taint nodes for scheduling).
package protect

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// Op categorizes the requested mutation. Most gates apply to both,
// but a few are op-specific (e.g. Node accepts edit but not delete).
type Op string

const (
	// OpModify covers PUT (kubectl-edit), SSA Patch (kubectl-apply)
	// and StrategicMerge Patch. From the protection layer's view they
	// all "change spec/metadata", so they share gates.
	OpModify Op = "modify"
	// OpDelete is dynamic.Delete — same underlying call whether the
	// trigger was a Delete button or an Apply YAML drawer's bulk
	// delete-f flow.
	OpDelete Op = "delete"
)

// GVK is a small group/version/kind triple, decoupled from the
// schema package's GroupVersionKind so this package doesn't pull in
// k8s.io/apimachinery just for a struct.
type GVK struct {
	Group, Version, Kind string
}

// Err is the rejection result. Status / Code map straight onto the
// HTTP response handler.go writes; Message is optional and used by
// validateDoc to render per-doc reasons in the bulk YAML response.
type Err struct {
	Status  int
	Code    string
	Message string
}

// Error codes — must stay in sync with handler.errors.go and the
// frontend `errors.{CODE}` i18n keys in web/src/locales.
const (
	CodeNamespaceProtected           = "NAMESPACE_PROTECTED"
	CodeCRDProtected                 = "CRD_PROTECTED"
	CodeNodeProtected                = "NODE_PROTECTED"
	CodeSystemProtected              = "SYSTEM_PROTECTED"
	CodeManagedResource              = "MANAGED_RESOURCE"
	CodeDefaultStorageClassProtected = "DEFAULT_STORAGECLASS_PROTECTED"
)

// hardcodedReadOnlyNamespaces lists namespaces whose contents are
// flat-out off-limits via the generic CRUD path. The previous
// implementation used `kube-` and `kpilot-` prefixes, but that
// over-protected:
//
//   - `kube-public` is intentionally world-readable info; nobody
//     stores critical state there
//   - `kube-node-lease` holds Lease objects that the kubelet auto-
//     recreates on next heartbeat
//   - user-created resources in `kpilot-monitoring` (e.g. a Secret
//     the operator added with custom credentials) are perfectly
//     editable in principle
//
// Now we hardcode only `kube-system` (CoreDNS, kube-proxy, …) and
// rely on the Helm-managed label check below to catch
// plugin-installed resources wherever they live.
var hardcodedReadOnlyNamespaces = map[string]bool{
	"kube-system": true,
}

// userEditableHelmResources is a small allowlist of (Kind, Name)
// pairs the UI explicitly mutates even though they're Helm-managed
// (and would otherwise be blocked by the managed-resource gate).
//
// Today: only the Volcano scheduler ConfigMap, which the 算力调度
// scheduler-config editor SSA-applies a new copy of. Delete is still
// rejected — wiping it bricks the Volcano scheduler.
var userEditableHelmResources = map[string]bool{
	"ConfigMap:volcano-scheduler-configmap": true,
}

// Check evaluates every protection rule for this op. Returns nil
// when allowed, or *Err with the HTTP status + code for the rejection.
//
// Gates run cheapest-first: static (no IO) gates trip before any
// worker round-trip is made. Lookup-based gates are intentionally
// error-tolerant — if the GET fails (worker offline, resource gone)
// we proceed and let the actual write surface the real error,
// instead of failing the request twice.
func Check(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID string,
	op Op,
	gvk GVK,
	namespace, name string,
) *Err {
	if e := checkStatic(op, gvk, namespace, name); e != nil {
		return e
	}
	return checkDynamic(ctx, gw, clusterID, op, gvk, namespace, name)
}

// checkStatic runs the gates that depend only on (op, gvk, ns, name)
// and never need to call out to the worker.
func checkStatic(op Op, gvk GVK, namespace, name string) *Err {
	if hardcodedReadOnlyNamespaces[namespace] {
		return &Err{
			Status: http.StatusForbidden,
			Code:   CodeNamespaceProtected,
		}
	}
	// kpilot-owned CRDs (anything under *.kpilot.io). Editing the CRD
	// could clear the schema and effectively disable the controller;
	// deleting it leaves every reconciler's Watch dangling.
	if isProtectedCRDDefinitionGVK(gvk, name) {
		return &Err{
			Status: http.StatusForbidden,
			Code:   CodeCRDProtected,
		}
	}
	// CR instances under kpilot-owned groups (Plugin, etc.) are
	// reconciler-managed; users should drive them via the dedicated
	// UI (Plugins page) instead of poking the CR directly.
	if isProtectedCRGroup(gvk.Group) {
		return &Err{
			Status: http.StatusForbidden,
			Code:   CodeCRDProtected,
		}
	}
	// Node: deleting a Node from a cloud-managed cluster orphans the
	// underlying VM and breaks the cluster autoscaler's bookkeeping.
	// Editing (label / taint / spec.unschedulable via the cordon
	// scoped endpoint or generic PUT) is allowed — power users
	// regularly add labels for scheduling, and K8s itself enforces
	// immutability on most Node fields.
	if op == OpDelete && gvk.Group == "" && gvk.Kind == "Node" {
		return &Err{
			Status: http.StatusForbidden,
			Code:   CodeNodeProtected,
		}
	}
	// system:* RBAC and system-* PriorityClass are control-plane
	// load-bearing — name-prefix match is precise enough that
	// user-created RBAC/PriorityClass without these prefixes pass
	// through untouched.
	if isProtectedSystemNameGVK(gvk, name) {
		return &Err{
			Status: http.StatusForbidden,
			Code:   CodeSystemProtected,
		}
	}
	return nil
}

// checkDynamic runs gates that need a worker GET. Errors from the
// underlying lookup (worker offline, resource missing) are swallowed:
// either the downstream write will surface a meaningful error, or the
// resource genuinely doesn't exist (so there's nothing to protect).
func checkDynamic(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID string,
	op Op,
	gvk GVK,
	namespace, name string,
) *Err {
	// Default StorageClass — modifying or deleting it leaves every
	// new PVC stuck Pending. Common fat-finger; trivial to detect via
	// the well-known annotation. Applies whether or not the SC was
	// installed by Helm.
	if gvk.Group == "storage.k8s.io" && gvk.Kind == "StorageClass" {
		if isDefault, err := isDefaultStorageClass(ctx, gw, clusterID, gvk, name); err == nil && isDefault {
			return &Err{
				Status: http.StatusForbidden,
				Code:   CodeDefaultStorageClassProtected,
			}
		}
	}

	// Helm-managed resources are off-limits via the generic CRUD path
	// regardless of namespace — the user should disable / re-enable the
	// owning plugin instead. Allowlisted (Kind, Name) pairs slip
	// through for OpModify only (delete still rejected; nuking a
	// plugin-installed resource bricks the plugin).
	if op == OpModify && userEditableHelmResources[gvk.Kind+":"+name] {
		return nil
	}
	if isManaged, err := isHelmManaged(ctx, gw, clusterID, gvk, namespace, name); err == nil && isManaged {
		return &Err{
			Status:  http.StatusForbidden,
			Code:    CodeManagedResource,
			Message: gvk.Kind + " " + name + " is managed by a Helm release; modify via the Plugins page",
		}
	}
	return nil
}

// ─── Static helpers ──────────────────────────────────────────────────

// isProtectedCRDDefinitionGVK returns true for CRD-definition writes
// targeting a kpilot-owned CRD (*.kpilot.io). Same _cr URL bypass
// concern as elsewhere — gates on the resolved GVK, not the URL :type.
func isProtectedCRDDefinitionGVK(gvk GVK, name string) bool {
	return gvk.Group == "apiextensions.k8s.io" &&
		gvk.Kind == "CustomResourceDefinition" &&
		strings.HasSuffix(name, ".kpilot.io")
}

// isProtectedCRGroup returns true for API groups kpilot owns. The CR
// instances (Plugin, etc.) are reconciler-managed and should not be
// edited via the generic CR viewer.
func isProtectedCRGroup(group string) bool {
	return group == "kpilot.io" || strings.HasSuffix(group, ".kpilot.io")
}

// isProtectedSystemNameGVK gates writes against control-plane
// objects whose well-known name prefix the cluster depends on.
// Deleting `cluster-admin` or `system-cluster-critical` would brick
// the cluster silently and irrecoverably.
func isProtectedSystemNameGVK(gvk GVK, name string) bool {
	if gvk.Group == "rbac.authorization.k8s.io" &&
		(gvk.Kind == "ClusterRole" || gvk.Kind == "ClusterRoleBinding") {
		return strings.HasPrefix(name, "system:")
	}
	if gvk.Group == "scheduling.k8s.io" && gvk.Kind == "PriorityClass" {
		return strings.HasPrefix(name, "system-")
	}
	return false
}

// ─── Dynamic (lookup-based) helpers ──────────────────────────────────

const (
	// helmManagedByLabel is the well-known Kubernetes recommended
	// label for Helm-installed resources. Both Helm v3 and v2 set
	// this. Some charts also set `helm.sh/release-name`, but the
	// managed-by label is more universal.
	helmManagedByLabel = "app.kubernetes.io/managed-by"
	helmManagedByValue = "Helm"

	// defaultStorageClassAnno is the K8s API contract for marking a
	// StorageClass as the cluster default; the storage controller
	// looks for this exact annotation when a PVC has no
	// storageClassName.
	defaultStorageClassAnno = "storageclass.kubernetes.io/is-default-class"
)

// isHelmManaged GETs the resource via the worker and returns true
// if it carries the `app.kubernetes.io/managed-by=Helm` label. Errors
// are returned as-is; callers swallow them.
func isHelmManaged(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID string,
	gvk GVK,
	namespace, name string,
) (bool, error) {
	obj, err := getResource(ctx, gw, clusterID, gvk, namespace, name)
	if err != nil || obj == nil {
		return false, err
	}
	meta, _ := obj["metadata"].(map[string]any)
	labels, _ := meta["labels"].(map[string]any)
	v, _ := labels[helmManagedByLabel].(string)
	return v == helmManagedByValue, nil
}

// isDefaultStorageClass GETs the StorageClass and checks whether it
// carries the well-known default-class annotation set to "true". The
// caller has already verified the GVK is StorageClass.
func isDefaultStorageClass(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID string,
	gvk GVK,
	name string,
) (bool, error) {
	obj, err := getResource(ctx, gw, clusterID, gvk, "", name)
	if err != nil || obj == nil {
		return false, err
	}
	meta, _ := obj["metadata"].(map[string]any)
	annos, _ := meta["annotations"].(map[string]any)
	v, _ := annos[defaultStorageClassAnno].(string)
	return v == "true", nil
}

// getResource is the shared one-shot worker GET used by the dynamic
// gates. We wrap SendResourceRequest rather than reusing handler-side
// code so this package stays free of HTTP / Gin dependencies.
func getResource(
	ctx context.Context,
	gw *gateway.GatewayServer,
	clusterID string,
	gvk GVK,
	namespace, name string,
) (map[string]any, error) {
	resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
		Action:    "get",
		Group:     gvk.Group,
		Version:   gvk.Version,
		Kind:      gvk.Kind,
		Namespace: namespace,
		Name:      name,
	})
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, errors.New(resp.Error)
	}
	var obj map[string]any
	if err := json.Unmarshal(resp.Data, &obj); err != nil {
		return nil, err
	}
	return obj, nil
}
