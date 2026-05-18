package proxy

import (
	"context"
	"encoding/json"
	"log"

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"

	"github.com/togettoyou/kpilot/pkg/common/volcano"
)

// volcano_status.go — cluster-side detection of Volcano so the
// frontend doesn't need to gate on KPilot's plugin registry.
//
// Two probes, both cheap:
//
//  1. RESTMapping for `scheduling.volcano.sh/v1beta1 Queue`. Mapper
//     looks the GVK up in its discovery cache; a no-match is the
//     canonical signal that the CRD isn't installed. Zero IO when
//     the cache is warm, one discovery refresh otherwise.
//  2. ConfigMap fieldSelector List on the whole cluster, filtered to
//     `metadata.name=volcano-scheduler-configmap`. apiserver returns
//     immediately with the matching row(s); we take the first one's
//     namespace as the scheduler release ns. No assumptions about
//     `kpilot-scheduling` vs `volcano-system` vs custom.
//
// Why a synthetic action instead of two ResourceRequest round-trips:
// it's a single Worker hop returning one JSON blob. Server-side
// handler unmarshals into the same shared type, frontend renders.
// Mirrors the vgpu-snapshot pattern.

const (
	volcanoQueueGroup   = "scheduling.volcano.sh"
	volcanoQueueVersion = "v1beta1"
	volcanoQueueKind    = "Queue"

	schedulerConfigMapName = "volcano-scheduler-configmap"
)

// volcanoStatus answers the "is Volcano here, and where's the
// scheduler ConfigMap" probe. Returns a populated Status on success;
// failure modes:
//
//   - RESTMapping fails with anything OTHER than NoMatch → propagate
//     as fail() so the server can surface the real error.
//   - NoMatch → return Installed=false, do NOT continue to the
//     ConfigMap probe (no point — Volcano isn't here).
//   - ConfigMap list errors → log, return Installed=true with empty
//     namespace. Scheduler page renders a "found Volcano but couldn't
//     locate config" hint rather than blanking out.
func (p *Proxy) volcanoStatus(ctx context.Context) *ResourceResponse {
	status := volcano.Status{}

	_, err := p.mapper.RESTMapping(
		schema.GroupKind{Group: volcanoQueueGroup, Kind: volcanoQueueKind},
		volcanoQueueVersion,
	)
	if err != nil {
		if apimeta.IsNoMatchError(err) {
			log.Printf("[volcano-status] CRD not present (NoMatch); installed=false")
			return marshalStatus(status)
		}
		return fail("volcano-status: map Queue: " + err.Error())
	}
	status.Installed = true

	// Same cfg as the rest of the proxy; cheap to build a typed
	// clientset on demand (kubernetes.NewForConfig is in-memory).
	cs, err := kubernetes.NewForConfig(p.cfg)
	if err != nil {
		// Shouldn't happen — same cfg already drives dyn + vgpu — but
		// surface as success-with-empty-ns so the scheduler page can
		// fall back to its NotInstalled state rather than 500.
		log.Printf("[volcano-status] kubernetes clientset: %v", err)
		return marshalStatus(status)
	}

	cms, err := cs.CoreV1().ConfigMaps("").List(ctx, metav1.ListOptions{
		FieldSelector: "metadata.name=" + schedulerConfigMapName,
		// Small limit — there should only ever be one of these. Cap
		// just in case a user split Volcano across namespaces.
		Limit: 5,
	})
	if err != nil {
		log.Printf("[volcano-status] list configmaps: %v", err)
		return marshalStatus(status)
	}
	if len(cms.Items) > 0 {
		status.SchedulerConfigMapNamespace = cms.Items[0].Namespace
		if len(cms.Items) > 1 {
			// More than one is a curiosity, not an error — pick the
			// first deterministically (List returns in name order per
			// apiserver semantics) and log the rest so an operator can
			// reconcile if it matters.
			others := make([]string, 0, len(cms.Items)-1)
			for _, c := range cms.Items[1:] {
				others = append(others, c.Namespace)
			}
			log.Printf("[volcano-status] multiple volcano-scheduler-configmap found, using %q; other namespaces: %v",
				status.SchedulerConfigMapNamespace, others)
		}
	}
	log.Printf("[volcano-status] installed=%t scheduler_ns=%q",
		status.Installed, status.SchedulerConfigMapNamespace)
	return marshalStatus(status)
}

func marshalStatus(s volcano.Status) *ResourceResponse {
	data, err := json.Marshal(s)
	if err != nil {
		return fail("marshal volcano status: " + err.Error())
	}
	return &ResourceResponse{Success: true, Data: data}
}
