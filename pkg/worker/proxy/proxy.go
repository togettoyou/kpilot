package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

const opTimeout = 30 * time.Second

// Proxy executes K8s resource operations on behalf of the Server.
// It is wired to the tunnel client via SetResourceHandler.
type Proxy struct {
	dyn    dynamic.Interface
	mapper apimeta.RESTMapper
	sendFn func(requestID string, resp *proto.ResourceResponse)
}

// New creates a Proxy. sendFn is called after each operation to return the
// result to the Server (typically tunnelClient.SendResourceResponse).
func New(cfg *rest.Config, mapper apimeta.RESTMapper, sendFn func(string, *proto.ResourceResponse)) (*Proxy, error) {
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("dynamic client: %w", err)
	}
	return &Proxy{dyn: dyn, mapper: mapper, sendFn: sendFn}, nil
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
	mapping, err := p.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return fail(fmt.Sprintf("map %v: %v", gvk, err))
	}

	switch req.Action {
	case "list":
		return p.list(ctx, mapping, req.Namespace, req.Limit, req.ContinueToken)
	case "get":
		return p.get(ctx, mapping, req.Namespace, req.Name)
	case "apply":
		return p.apply(ctx, mapping, req.Namespace, req.Name, req.Body)
	case "delete":
		return p.delete(ctx, mapping, req.Namespace, req.Name)
	default:
		return fail("unsupported action: " + req.Action)
	}
}

func (p *Proxy) list(ctx context.Context, mapping *apimeta.RESTMapping, namespace string, limit int64, continueToken string) *proto.ResourceResponse {
	opts := metav1.ListOptions{}
	if limit > 0 {
		opts.Limit = limit
	}
	if continueToken != "" {
		opts.Continue = continueToken
	}
	ri := p.dyn.Resource(mapping.Resource)
	var result interface{}
	var err error
	if namespace != "" {
		result, err = ri.Namespace(namespace).List(ctx, opts)
	} else {
		// Empty namespace → all namespaces (cluster-scoped resources also work here).
		result, err = ri.List(ctx, opts)
	}
	if err != nil {
		return fail(err.Error())
	}
	return marshal(result)
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
	obj := &unstructured.Unstructured{}
	if err := json.Unmarshal(body, obj); err != nil {
		return fail("invalid body: " + err.Error())
	}
	ri := p.dyn.Resource(mapping.Resource)
	var result *unstructured.Unstructured
	var err error
	if namespace != "" {
		result, err = ri.Namespace(namespace).Update(ctx, obj, metav1.UpdateOptions{})
	} else {
		result, err = ri.Update(ctx, obj, metav1.UpdateOptions{})
	}
	if err != nil {
		return fail(err.Error())
	}
	return marshal(result)
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
	log.Printf("[proxy] error: %s", msg)
	return &proto.ResourceResponse{Success: false, Error: msg}
}
