package plugin

import (
	"sync"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/cli-runtime/pkg/genericclioptions"
	"k8s.io/client-go/discovery"
	memcached "k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
)

// restClientGetter adapts a *rest.Config to genericclioptions.RESTClientGetter,
// the interface Helm's action.Configuration consumes for kube access.
//
// Helm's CLI normally constructs this from kubeconfig flags; we already have
// an in-cluster (or kubeconfig-derived) *rest.Config so we wrap it directly
// rather than re-parsing.
//
// The memcached discovery client and the deferred REST mapper are
// memoized per Getter instance — Helm calls ToDiscoveryClient /
// ToRESTMapper many times during a single install (validation, resource
// ordering, hook resolution), and the previous fresh-each-call version
// defeated memcached's whole purpose. Result: every install ran cluster
// discovery 3-5×.
type restClientGetter struct {
	cfg       *rest.Config
	namespace string

	mu         sync.Mutex
	disco      discovery.CachedDiscoveryInterface
	discoErr   error
	mapper     meta.RESTMapper
	mapperOnce sync.Once
}

func newRESTClientGetter(cfg *rest.Config, namespace string) genericclioptions.RESTClientGetter {
	if namespace == "" {
		namespace = "default"
	}
	return &restClientGetter{cfg: cfg, namespace: namespace}
}

func (r *restClientGetter) ToRESTConfig() (*rest.Config, error) {
	return r.cfg, nil
}

func (r *restClientGetter) ToDiscoveryClient() (discovery.CachedDiscoveryInterface, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.disco != nil || r.discoErr != nil {
		return r.disco, r.discoErr
	}
	dc, err := discovery.NewDiscoveryClientForConfig(r.cfg)
	if err != nil {
		r.discoErr = err
		return nil, err
	}
	r.disco = memcached.NewMemCacheClient(dc)
	return r.disco, nil
}

func (r *restClientGetter) ToRESTMapper() (meta.RESTMapper, error) {
	dc, err := r.ToDiscoveryClient()
	if err != nil {
		return nil, err
	}
	// Memoize the mapper. NewDeferredDiscoveryRESTMapper does its own
	// lazy discovery but constructing the mapper itself is non-trivial
	// (wraps the discovery client, builds the shortcut expander chain);
	// Helm's flows touch this many times per reconcile.
	r.mapperOnce.Do(func() {
		mapper := restmapper.NewDeferredDiscoveryRESTMapper(dc)
		r.mapper = restmapper.NewShortcutExpander(mapper, dc, nil)
	})
	return r.mapper, nil
}

func (r *restClientGetter) ToRawKubeConfigLoader() clientcmd.ClientConfig {
	// Helm's action.Configuration only reads the namespace via this method
	// (and only when ToRESTConfig isn't sufficient). Returning a synthetic
	// loader that exposes the namespace and the rest.Config keeps Helm
	// happy without needing an actual kubeconfig file on disk.
	return clientcmd.NewDefaultClientConfig(
		clientcmdRawConfigFromRest(r.cfg, r.namespace),
		&clientcmd.ConfigOverrides{},
	)
}
