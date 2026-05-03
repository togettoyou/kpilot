package plugin

import (
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
type restClientGetter struct {
	cfg       *rest.Config
	namespace string
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
	dc, err := discovery.NewDiscoveryClientForConfig(r.cfg)
	if err != nil {
		return nil, err
	}
	return memcached.NewMemCacheClient(dc), nil
}

func (r *restClientGetter) ToRESTMapper() (meta.RESTMapper, error) {
	dc, err := r.ToDiscoveryClient()
	if err != nil {
		return nil, err
	}
	mapper := restmapper.NewDeferredDiscoveryRESTMapper(dc)
	return restmapper.NewShortcutExpander(mapper, dc, nil), nil
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
