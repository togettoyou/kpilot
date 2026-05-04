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
	mapper     apimeta.RESTMapper
	sendFn     func(requestID string, resp *proto.ResourceResponse)
}

// restMapping looks up the GVK with one auto-retry on NoMatch.
//
// Controller-runtime's dynamic RESTMapper caches API discovery and only
// re-fetches on demand, but a CRD newly installed by a Helm plugin
// (e.g. envoy-gateway adding GatewayClass / HTTPRoute / etc.) lands
// after our cache was already populated. Without a refresh, every
// subsequent Apply YAML for those new kinds fails with "no matches for
// kind" until the worker process restarts.
//
// Strategy: on NoMatch, invalidate the cache via meta.ResettableRESTMapper
// and try once more. The retry forces a fresh API discovery round-trip,
// after which the new CRD's GVK becomes resolvable. Genuine typos
// (kind doesn't exist) cost one extra round-trip; that's a fine price
// for never having to restart the worker after installing a CRD-bearing
// chart.
func (p *Proxy) restMapping(gvk schema.GroupVersionKind) (*apimeta.RESTMapping, error) {
	mapping, err := p.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err == nil {
		return mapping, nil
	}
	if !apimeta.IsNoMatchError(err) {
		return nil, err
	}
	rm, ok := p.mapper.(apimeta.ResettableRESTMapper)
	if !ok {
		return nil, err
	}
	log.Printf("[proxy] RESTMapping miss, resetting discovery cache: gvk=%v", gvk)
	rm.Reset()
	return p.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
}

// New creates a Proxy. sendFn is called after each operation to return the
// result to the Server (typically tunnelClient.SendResourceResponse).
func New(cfg *rest.Config, mapper apimeta.RESTMapper, sendFn func(string, *proto.ResourceResponse)) (*Proxy, error) {
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
	return &Proxy{cfg: cfg, httpClient: httpClient, dyn: dyn, mapper: mapper, sendFn: sendFn}, nil
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
	gvk := schema.GroupVersionKind{
		Group:   req.Group,
		Version: req.Version,
		Kind:    req.Kind,
	}
	mapping, err := p.restMapping(gvk)
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
	ri := p.dyn.Resource(mapping.Resource)
	var result interface{}
	var err error
	if namespace != "" {
		result, err = ri.Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	} else {
		result, err = ri.Get(ctx, name, metav1.GetOptions{})
	}
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
	ri := p.dyn.Resource(mapping.Resource)
	var result *unstructured.Unstructured
	var err error
	if namespace != "" {
		result, err = ri.Namespace(namespace).Patch(ctx, name, k8stypes.ApplyPatchType, body, opts)
	} else {
		result, err = ri.Patch(ctx, name, k8stypes.ApplyPatchType, body, opts)
	}
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
	ri := p.dyn.Resource(mapping.Resource)
	opts := metav1.UpdateOptions{FieldManager: "kpilot"}
	var result *unstructured.Unstructured
	var err error
	if namespace != "" {
		result, err = ri.Namespace(namespace).Update(ctx, obj, opts)
	} else {
		result, err = ri.Update(ctx, obj, opts)
	}
	if err != nil {
		return fail(err.Error())
	}
	return marshal(result)
}

// describe returns the same human-readable text that `kubectl describe` would
// produce, by delegating to the official k8s.io/kubectl describer for the
// resource's GroupKind. ShowEvents=true so the output includes the recent
// events block — that's the most useful part for debugging.
func (p *Proxy) describe(mapping *apimeta.RESTMapping, namespace, name string) *proto.ResourceResponse {
	if name == "" {
		return fail("name is required for describe")
	}
	describer, ok := describe.DescriberFor(mapping.GroupVersionKind.GroupKind(), p.cfg)
	if !ok {
		return fail(fmt.Sprintf("no describer for %s", mapping.GroupVersionKind.Kind))
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
	ri := p.dyn.Resource(mapping.Resource)
	var err error
	if namespace != "" {
		err = ri.Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	} else {
		err = ri.Delete(ctx, name, metav1.DeleteOptions{})
	}
	if err != nil {
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
