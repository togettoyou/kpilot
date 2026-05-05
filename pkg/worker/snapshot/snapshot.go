// Package snapshot provides cached read-through access to Nodes and Pods
// on the local cluster. Backed by client-go's SharedInformerFactory:
// one watch + one List on startup per kind, then watch events keep the
// in-memory cache live. Reads are slice copies from the indexer — sub-
// millisecond, no API-server round trip.
//
// Why this lives separate from the existing controller-runtime Manager
// (which already runs Node + Plugin CRD informers for the collector
// and plugin reconciler): those are purpose-built around reconcile
// loops. This package is purely "snapshot the world for synchronous
// reads" used by the GPU summary endpoint and any future page that
// wants whole-cluster Node/Pod state at request time without
// pounding kube-apiserver.
//
// The doubled Node watch (collector + here) costs a few MB and one
// extra watch stream — cheap insurance against coupling unrelated
// concerns. Worth unifying later if it actually hurts.
package snapshot

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	listerscorev1 "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"
)

// resyncPeriod is how often the informer re-lists from kube-apiserver
// to reconcile any missed watch events. 1h matches the controller-
// runtime default; watch events already keep us live, resync is a
// safety net for edge cases like a torn watch over a network blip.
const resyncPeriod = time.Hour

// cacheSyncTimeout caps how long Worker startup waits for the initial
// List to populate the cache. On a 5k-pod cluster this can take a few
// seconds; 30s is enough headroom for cold caches without making startup
// hang on a genuinely broken API server.
const cacheSyncTimeout = 30 * time.Second

// Snapshot exposes lister-backed reads over the cluster's Nodes and
// Pods. All methods are non-blocking and concurrency-safe.
type Snapshot struct {
	factory    informers.SharedInformerFactory
	nodeLister listerscorev1.NodeLister
	podLister  listerscorev1.PodLister
}

// New wires up the informer factory, starts the watches, and blocks
// until the initial cache sync completes (or cacheSyncTimeout fires).
// stop should be ctx.Done() of the worker's root context — closing it
// tears down the watch streams cleanly.
func New(clientset kubernetes.Interface, stop <-chan struct{}) (*Snapshot, error) {
	factory := informers.NewSharedInformerFactory(clientset, resyncPeriod)
	nodeInformer := factory.Core().V1().Nodes()
	podInformer := factory.Core().V1().Pods()

	// Touch the lister builders so factory.Start knows to launch their
	// underlying informers. (Calling .Lister() / .Informer() registers
	// them with the factory; factory.Start would skip kinds nobody
	// asked for otherwise.)
	_ = nodeInformer.Lister()
	_ = podInformer.Lister()

	factory.Start(stop)

	syncCtx, cancel := context.WithTimeout(context.Background(), cacheSyncTimeout)
	defer cancel()
	if !cache.WaitForCacheSync(syncCtx.Done(),
		nodeInformer.Informer().HasSynced,
		podInformer.Informer().HasSynced,
	) {
		return nil, fmt.Errorf("snapshot cache sync timed out after %v", cacheSyncTimeout)
	}

	return &Snapshot{
		factory:    factory,
		nodeLister: nodeInformer.Lister(),
		podLister:  podInformer.Lister(),
	}, nil
}

// Nodes returns the current snapshot of every Node. The returned slice
// is freshly allocated by the lister; the Node objects themselves are
// shared with the cache and MUST NOT be mutated by callers — make a
// DeepCopy first if you need to write.
func (s *Snapshot) Nodes() ([]*corev1.Node, error) {
	return s.nodeLister.List(labels.Everything())
}

// Pods returns the current snapshot of every Pod across all namespaces.
// Same lifetime caveat as Nodes — read-only.
func (s *Snapshot) Pods() ([]*corev1.Pod, error) {
	return s.podLister.List(labels.Everything())
}
