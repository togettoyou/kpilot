package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	k8stypes "k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/kubectl/pkg/describe"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/worker/snapshot"
)

const opTimeout = 30 * time.Second

// tableAccept mirrors kubectl's exact Accept header for table requests.
// Format from k8s.io/kubectl source:
//
//	application/json;as=Table;v=v1;g=meta.k8s.io   (GA, K8s ≥ 1.23)
//	application/json;as=Table;v=v1beta1;g=meta.k8s.io (beta, K8s ≥ 1.10)
//	application/json                                  (fallback)
const tableAccept = "application/json;as=Table;v=v1;g=meta.k8s.io," +
	"application/json;as=Table;v=v1beta1;g=meta.k8s.io," +
	"application/json"

// Proxy executes K8s resource operations on behalf of the Server.
// It is wired to the tunnel client via SetResourceHandler.
type Proxy struct {
	cfg        *rest.Config
	httpClient *http.Client // reused for Table API list requests
	dyn        dynamic.Interface
	// snap is the lister-backed cache used for actions that read the
	// whole-cluster Node/Pod state on every request (e.g. gpu-summary).
	// Workload list/get etc. still go through the dynamic client + Table
	// API since they're per-kind, paginated, and shouldn't share a cache
	// across all GVKs anyway.
	snap   *snapshot.Snapshot
	mapper apimeta.RESTMapper
	sendFn func(requestID string, resp *proto.ResourceResponse)
}

// resourceClient picks namespace-scoped vs cluster-scoped REST access
// based on the GVK's discovered scope, NOT on whether the caller passed
// a namespace. The Apply YAML drawer accepts user-pasted manifests; if
// a Service/Deployment/Gateway/etc. (namespace-scoped) lacks a
// metadata.namespace, GetNamespace returned "", we previously dispatched
// through the cluster-scoped path, and K8s 404'd with "the server could
// not find the requested resource" because there is no cluster-scoped
// Service kind. kubectl handles this by defaulting to "default"; do the
// same. For cluster-scoped kinds we always ignore any namespace input.
//
// Returns (resourceInterface, effectiveNamespace) — effectiveNamespace
// is what we'll log / report back; for cluster-scoped resources it's
// always "".
func (p *Proxy) resourceClient(mapping *apimeta.RESTMapping, namespace string) (dynamic.ResourceInterface, string) {
	ri := p.dyn.Resource(mapping.Resource)
	if mapping.Scope.Name() != apimeta.RESTScopeNameNamespace {
		return ri, ""
	}
	ns := namespace
	if ns == "" {
		ns = "default"
	}
	return ri.Namespace(ns), ns
}

// New creates a Proxy. snap is the cluster-wide Node/Pod snapshot used
// by gpu-summary and any future bulk-read actions; pass it pre-warmed
// (call snapshot.New first, wait for sync, then construct the Proxy).
// sendFn is called after each operation to return the result to the
// Server (typically tunnelClient.SendResourceResponse).
func New(
	cfg *rest.Config,
	mapper apimeta.RESTMapper,
	snap *snapshot.Snapshot,
	sendFn func(string, *proto.ResourceResponse),
) (*Proxy, error) {
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("dynamic client: %w", err)
	}
	// rest.HTTPClientFor builds an *http.Client with the TLS/auth transport
	// from the rest.Config (bearer token, client cert, CA, etc.).
	httpClient, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return nil, fmt.Errorf("http client: %w", err)
	}
	return &Proxy{
		cfg:        cfg,
		httpClient: httpClient,
		dyn:        dyn,
		snap:       snap,
		mapper:     mapper,
		sendFn:     sendFn,
	}, nil
}

// Handle satisfies the tunnel.Client.SetResourceHandler signature.
// It runs in its own goroutine per request.
func (p *Proxy) Handle(requestID string, req *proto.ResourceRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	resp := p.execute(ctx, req)
	p.sendFn(requestID, resp)
}

func (p *Proxy) execute(ctx context.Context, req *proto.ResourceRequest) *proto.ResourceResponse {
	// Special-case actions that don't bind to a single GVK and so don't
	// need (and would error on) the RESTMapping lookup below.
	if req.Action == "gpu-summary" {
		return p.gpuSummary(ctx)
	}

	gvk := schema.GroupVersionKind{
		Group:   req.Group,
		Version: req.Version,
		Kind:    req.Kind,
	}
	mapping, err := p.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return fail(fmt.Sprintf("map %v: %v", gvk, err))
	}

	switch req.Action {
	case "list":
		return p.listTable(ctx, mapping, req.Namespace, req.Limit, req.ContinueToken)
	case "get":
		return p.get(ctx, mapping, req.Namespace, req.Name)
	case "apply":
		return p.apply(ctx, mapping, req.Namespace, req.Name, req.Body)
	case "update":
		return p.update(ctx, mapping, req.Namespace, req.Body)
	case "delete":
		return p.delete(ctx, mapping, req.Namespace, req.Name)
	case "describe":
		return p.describe(mapping, req.Namespace, req.Name)
	default:
		return fail("unsupported action: " + req.Action)
	}
}

// listTable uses the K8s Table API (same as kubectl default display).
// The API server computes display cells server-side; only cell values and
// object metadata are returned — spec/status are NOT transferred.
func (p *Proxy) listTable(ctx context.Context, mapping *apimeta.RESTMapping, namespace string, limit int64, continueToken string) *proto.ResourceResponse {
	gv := mapping.Resource.GroupVersion()

	var apiPrefix string
	if gv.Group == "" {
		apiPrefix = fmt.Sprintf("/api/%s", gv.Version)
	} else {
		apiPrefix = fmt.Sprintf("/apis/%s/%s", gv.Group, gv.Version)
	}

	var resourcePath string
	if namespace != "" {
		resourcePath = fmt.Sprintf("%s/namespaces/%s/%s", apiPrefix, url.PathEscape(namespace), mapping.Resource.Resource)
	} else {
		resourcePath = fmt.Sprintf("%s/%s", apiPrefix, mapping.Resource.Resource)
	}

	params := url.Values{}
	// Metadata only — name/namespace/resourceVersion for actions, no spec/status.
	params.Set("includeObject", "Metadata")
	if limit > 0 {
		params.Set("limit", strconv.FormatInt(limit, 10))
	}
	if continueToken != "" {
		params.Set("continue", continueToken)
	}

	rawURL := strings.TrimRight(p.cfg.Host, "/") + resourcePath + "?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fail(fmt.Sprintf("build request: %v", err))
	}
	req.Header.Set("Accept", tableAccept)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return fail(fmt.Sprintf("table request: %v", err))
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fail(fmt.Sprintf("read body: %v", err))
	}
	if resp.StatusCode != http.StatusOK {
		return fail(fmt.Sprintf("K8s API %d: %s", resp.StatusCode, string(data)))
	}

	return &proto.ResourceResponse{Success: true, Data: data}
}

func (p *Proxy) get(ctx context.Context, mapping *apimeta.RESTMapping, namespace, name string) *proto.ResourceResponse {
	if name == "" {
		return fail("name is required for get")
	}
	ri, _ := p.resourceClient(mapping, namespace)
	result, err := ri.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fail(err.Error())
	}
	return marshal(result)
}

func (p *Proxy) apply(ctx context.Context, mapping *apimeta.RESTMapping, namespace, name string, body []byte) *proto.ResourceResponse {
	if name == "" {
		return fail("name is required for apply")
	}
	// Validate JSON before sending to K8s.
	if !json.Valid(body) {
		return fail("invalid body: not valid JSON")
	}
	// Server-Side Apply: declarative, idempotent, no resourceVersion required.
	forceTrue := true
	opts := metav1.PatchOptions{FieldManager: "kpilot", Force: &forceTrue}
	ri, _ := p.resourceClient(mapping, namespace)
	result, err := ri.Patch(ctx, name, k8stypes.ApplyPatchType, body, opts)
	if err != nil {
		return fail(err.Error())
	}
	return marshal(result)
}

// update is the kubectl-edit equivalent: PUT the full object, K8s rejects
// the call if the body's resourceVersion is stale (someone else modified
// the object since the user opened the editor). This is what users expect
// when they hit "save" in a YAML editor — what they typed is what lands,
// no field-ownership games like SSA, and concurrent edits surface as a
// 409 instead of one user silently overwriting the other.
//
// Used by ApplyWorkload (per-row Edit YAML). Apply YAML drawer keeps SSA
// because that's `kubectl apply` semantics — declarative, idempotent,
// no resourceVersion needed (intentional for drift-correcting workflows).
func (p *Proxy) update(ctx context.Context, mapping *apimeta.RESTMapping, namespace string, body []byte) *proto.ResourceResponse {
	if !json.Valid(body) {
		return fail("invalid body: not valid JSON")
	}
	obj := &unstructured.Unstructured{}
	if err := obj.UnmarshalJSON(body); err != nil {
		return fail(err.Error())
	}
	if obj.GetResourceVersion() == "" {
		return fail("metadata.resourceVersion is required; reload the resource and retry")
	}
	ri, _ := p.resourceClient(mapping, namespace)
	opts := metav1.UpdateOptions{FieldManager: "kpilot"}
	result, err := ri.Update(ctx, obj, opts)
	if err != nil {
		return fail(err.Error())
	}
	return marshal(result)
}

// describe returns the same human-readable text that `kubectl describe`
// would produce, by delegating to the official k8s.io/kubectl describer.
//
// For built-in K8s kinds (Pod, Deployment, Service, …) DescriberFor
// returns a per-kind specialized describer that knows about field
// semantics (e.g. Pod's container statuses, Service's endpoints).
//
// For CRDs (Gateway API, Envoy Gateway policies, custom plugin CRDs,
// etc.) there's no specialized describer registered, so we fall back
// to GenericDescriberFor — the same fallback `kubectl describe` itself
// uses. It pretty-prints metadata + spec + status fields and includes
// the events block, which is what users actually want for "describe".
//
// ShowEvents=true so output always includes the recent events block.
func (p *Proxy) describe(mapping *apimeta.RESTMapping, namespace, name string) *proto.ResourceResponse {
	if name == "" {
		return fail("name is required for describe")
	}
	describer, ok := describe.DescriberFor(mapping.GroupVersionKind.GroupKind(), p.cfg)
	if !ok {
		describer, ok = describe.GenericDescriberFor(mapping, p.cfg)
		if !ok {
			return fail(fmt.Sprintf("no describer for %s", mapping.GroupVersionKind.Kind))
		}
	}
	output, err := describer.Describe(namespace, name, describe.DescriberSettings{ShowEvents: true})
	if err != nil {
		return fail(err.Error())
	}
	return &proto.ResourceResponse{Success: true, Data: []byte(output)}
}

func (p *Proxy) delete(ctx context.Context, mapping *apimeta.RESTMapping, namespace, name string) *proto.ResourceResponse {
	if name == "" {
		return fail("name is required for delete")
	}
	ri, _ := p.resourceClient(mapping, namespace)
	if err := ri.Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		return fail(err.Error())
	}
	return &proto.ResourceResponse{Success: true}
}

func marshal(v interface{}) *proto.ResourceResponse {
	data, err := json.Marshal(v)
	if err != nil {
		return fail(err.Error())
	}
	return &proto.ResourceResponse{Success: true, Data: data}
}

func fail(msg string) *proto.ResourceResponse {
	log.Printf("[proxy] resource op failed: err=%q", msg)
	return &proto.ResourceResponse{Success: false, Error: msg}
}
