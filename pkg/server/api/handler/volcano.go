package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// volcano.go — dedicated list endpoints for the 算力调度 platform's
// Volcano CR pages. These hit the worker's `list-full` action (which
// uses dynamic.List to fetch full objects in one request) and project
// the fields the UI needs into a slim per-kind shape.
//
// The generic /workloads/_cr path uses the K8s Table API + per-row
// GETs to populate spec/status — that's the right call for arbitrary
// CRDs but a 100×N+1 pattern for Volcano resources where every cell
// the user actually cares about (Queue.status.state, Job.status.phase,
// CronJob.spec.suspend, ...) lives in spec/status. One call here
// returns it all in one round-trip.

// defaultVolcanoListLimit caps how many objects we'll project per
// request when the caller didn't pass a limit. Without a cap, a
// pathological cluster with thousands of Jobs could blow past the
// gRPC 32 MiB ceiling on the worker → server hop. 500 covers
// realistic Volcano deployments while still bounding worst-case
// payload size.
const defaultVolcanoListLimit int64 = 500

// listResponse is the wire shape for every Volcano list endpoint.
// Items is generic on each handler's row type; the JSON layout is
// flat enough that a single struct serves all five kinds. continue
// + remainingItemCount mirror the K8s list metadata so the frontend
// can show a "result truncated" hint and (later) wire prev/next
// cursor pagination without a server change.
type volcanoListResponse[T any] struct {
	Items                []T    `json:"items"`
	Continue             string `json:"continue,omitempty"`
	RemainingItemCount   *int64 `json:"remainingItemCount,omitempty"`
}

// parseListParams pulls limit + continue from the request and applies
// the defaultVolcanoListLimit. limit is capped on the high end too so
// a curl with limit=999999 can't bypass the worker payload guard.
func parseListParams(c *gin.Context) (int64, string) {
	limit := defaultVolcanoListLimit
	if s := c.Query("limit"); s != "" {
		if v, err := strconv.ParseInt(s, 10, 64); err == nil && v > 0 {
			if v > defaultVolcanoListLimit {
				v = defaultVolcanoListLimit
			}
			limit = v
		}
	}
	return limit, c.Query("continue")
}

// ─── Queue ─────────────────────────────────────────────────────────────

type queueRow struct {
	Name              string            `json:"name"`
	UID               string            `json:"uid"`
	CreationTimestamp string            `json:"creationTimestamp"`
	Weight            int64             `json:"weight"`
	Priority          int64             `json:"priority,omitempty"`
	State             string            `json:"state"`
	Parent            string            `json:"parent,omitempty"`
	Reclaimable       *bool             `json:"reclaimable,omitempty"`
	Capability        map[string]string `json:"capability,omitempty"`
	// Guarantee: soft floor — Volcano spec stores it nested as
	// spec.guarantee.resource (ResourceList), not flat under
	// spec.guarantee. The form builder writes it nested, so we
	// unwrap during projection.
	Guarantee map[string]string `json:"guarantee,omitempty"`
	// Deserved: capacity-aware-plugin field — what the queue
	// should receive after the capacity plugin reapportions
	// resources. Only present when the capacity plugin is in the
	// scheduler config; otherwise absent.
	Deserved  map[string]string `json:"deserved,omitempty"`
	Allocated map[string]string `json:"allocated,omitempty"`
	Running   int64             `json:"running"`
	Pending   int64             `json:"pending"`
	Inqueue   int64             `json:"inqueue"`
	Completed int64             `json:"completed"`
	Unknown   int64             `json:"unknown"`
}

func ListVolcanoQueues(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "scheduling.volcano.sh",
			Version:       "v1beta1",
			Kind:          "Queue",
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=Queue", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]queueRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			status := mapOf(it["status"])
			row := queueRow{
				Name:              str(meta["name"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				Weight:            int64Of(spec["weight"]),
				Priority:          int64Of(spec["priority"]),
				State:             str(status["state"]),
				Parent:            str(spec["parent"]),
				Capability:        stringMap(spec["capability"]),
				Deserved:          stringMap(spec["deserved"]),
				Allocated:         stringMap(status["allocated"]),
				Running:           int64Of(status["running"]),
				Pending:           int64Of(status["pending"]),
				Inqueue:           int64Of(status["inqueue"]),
				Completed:         int64Of(status["completed"]),
				Unknown:           int64Of(status["unknown"]),
			}
			// spec.guarantee is { resource: ResourceList } — unwrap.
			if g := mapOf(spec["guarantee"]); g != nil {
				row.Guarantee = stringMap(g["resource"])
			}
			if r, ok := spec["reclaimable"].(bool); ok {
				row.Reclaimable = &r
			}
			out = append(out, row)
		}
		c.JSON(http.StatusOK, volcanoListResponse[queueRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// ─── Job (batch.volcano.sh/v1alpha1) ───────────────────────────────────

type jobTaskRow struct {
	Name     string `json:"name"`
	Replicas int64  `json:"replicas"`
	Image    string `json:"image"`
}

type jobRow struct {
	Name              string       `json:"name"`
	Namespace         string       `json:"namespace"`
	UID               string       `json:"uid"`
	CreationTimestamp string       `json:"creationTimestamp"`
	Queue             string       `json:"queue,omitempty"`
	SchedulerName     string       `json:"schedulerName,omitempty"`
	PriorityClassName string       `json:"priorityClassName,omitempty"`
	MinAvailable      int64        `json:"minAvailable"`
	State             string       `json:"state"`
	Pending           int64        `json:"pending"`
	Running           int64        `json:"running"`
	Succeeded         int64        `json:"succeeded"`
	Failed            int64        `json:"failed"`
	Terminating       int64        `json:"terminating"`
	Unknown           int64        `json:"unknown"`
	Plugins           []string     `json:"plugins,omitempty"`
	Tasks             []jobTaskRow `json:"tasks,omitempty"`
}

func ListVolcanoJobs(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Query("namespace")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "batch.volcano.sh",
			Version:       "v1alpha1",
			Kind:          "Job",
			Namespace:     namespace,
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=Job", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]jobRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			status := mapOf(it["status"])
			state := mapOf(status["state"])
			tasks := sliceOf(spec["tasks"])
			plugins := pluginNames(spec["plugins"])
			out = append(out, jobRow{
				Name:              str(meta["name"]),
				Namespace:         str(meta["namespace"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				Queue:             str(spec["queue"]),
				SchedulerName:     str(spec["schedulerName"]),
				PriorityClassName: str(spec["priorityClassName"]),
				MinAvailable:      int64Of(spec["minAvailable"]),
				State:             str(state["phase"]),
				Pending:           int64Of(status["pending"]),
				Running:           int64Of(status["running"]),
				Succeeded:         int64Of(status["succeeded"]),
				Failed:            int64Of(status["failed"]),
				Terminating:       int64Of(status["terminating"]),
				Unknown:           int64Of(status["unknown"]),
				Plugins:           plugins,
				Tasks:             jobTasksOf(tasks),
			})
		}
		c.JSON(http.StatusOK, volcanoListResponse[jobRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// ─── CronJob (batch.volcano.sh/v1alpha1) ───────────────────────────────

type cronJobRow struct {
	Name              string `json:"name"`
	Namespace         string `json:"namespace"`
	UID               string `json:"uid"`
	CreationTimestamp string `json:"creationTimestamp"`
	Schedule          string `json:"schedule"`
	ConcurrencyPolicy string `json:"concurrencyPolicy,omitempty"`
	Suspend           bool   `json:"suspend"`
	LastScheduleTime  string `json:"lastScheduleTime,omitempty"`
	ActiveCount       int    `json:"activeCount"`
}

func ListVolcanoCronJobs(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Query("namespace")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "batch.volcano.sh",
			Version:       "v1alpha1",
			Kind:          "CronJob",
			Namespace:     namespace,
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=CronJob", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]cronJobRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			status := mapOf(it["status"])
			active := sliceOf(status["active"])
			suspend, _ := spec["suspend"].(bool)
			out = append(out, cronJobRow{
				Name:              str(meta["name"]),
				Namespace:         str(meta["namespace"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				Schedule:          str(spec["schedule"]),
				ConcurrencyPolicy: str(spec["concurrencyPolicy"]),
				Suspend:           suspend,
				LastScheduleTime:  str(status["lastScheduleTime"]),
				ActiveCount:       len(active),
			})
		}
		c.JSON(http.StatusOK, volcanoListResponse[cronJobRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// ─── PodGroup (scheduling.volcano.sh/v1beta1) ──────────────────────────

type podGroupRow struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace"`
	UID               string            `json:"uid"`
	CreationTimestamp string            `json:"creationTimestamp"`
	Queue             string            `json:"queue,omitempty"`
	PriorityClassName string            `json:"priorityClassName,omitempty"`
	MinMember         int64             `json:"minMember"`
	MinResources      map[string]string `json:"minResources,omitempty"`
	Phase             string            `json:"phase"`
	Running           int64             `json:"running"`
	Succeeded         int64             `json:"succeeded"`
	Failed            int64             `json:"failed"`
}

func ListVolcanoPodGroups(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Query("namespace")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "scheduling.volcano.sh",
			Version:       "v1beta1",
			Kind:          "PodGroup",
			Namespace:     namespace,
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=PodGroup", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]podGroupRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			status := mapOf(it["status"])
			out = append(out, podGroupRow{
				Name:              str(meta["name"]),
				Namespace:         str(meta["namespace"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				Queue:             str(spec["queue"]),
				PriorityClassName: str(spec["priorityClassName"]),
				MinMember:         int64Of(spec["minMember"]),
				MinResources:      stringMap(spec["minResources"]),
				Phase:             str(status["phase"]),
				Running:           int64Of(status["running"]),
				Succeeded:         int64Of(status["succeeded"]),
				Failed:            int64Of(status["failed"]),
			})
		}
		c.JSON(http.StatusOK, volcanoListResponse[podGroupRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// ─── HyperNode (topology.volcano.sh/v1alpha1) ──────────────────────────

type hyperNodeRow struct {
	Name              string            `json:"name"`
	UID               string            `json:"uid"`
	CreationTimestamp string            `json:"creationTimestamp"`
	Tier              int64             `json:"tier"`
	Members           []hyperNodeMember `json:"members,omitempty"`
}

type hyperNodeMember struct {
	Type     string `json:"type"`     // Node | HyperNode
	Selector string `json:"selector"` // value of the matching selector field
}

func ListVolcanoHyperNodes(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "topology.volcano.sh",
			Version:       "v1alpha1",
			Kind:          "HyperNode",
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=HyperNode", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]hyperNodeRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			members := sliceOf(spec["members"])
			row := hyperNodeRow{
				Name:              str(meta["name"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				Tier:              int64Of(spec["tier"]),
			}
			for _, m := range members {
				mm := mapOf(m)
				row.Members = append(row.Members, hyperNodeMember{
					Type:     str(mm["type"]),
					Selector: extractSelector(mm["selector"]),
				})
			}
			out = append(out, row)
		}
		c.JSON(http.StatusOK, volcanoListResponse[hyperNodeRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// ─── JobFlow (flow.volcano.sh/v1alpha1) ────────────────────────────────

type jobFlowRow struct {
	Name              string   `json:"name"`
	Namespace         string   `json:"namespace"`
	UID               string   `json:"uid"`
	CreationTimestamp string   `json:"creationTimestamp"`
	Phase             string   `json:"phase"`
	JobRetainPolicy   string   `json:"jobRetainPolicy,omitempty"`
	// Slim status counts. Each is the count of names in the
	// corresponding status list — the names themselves are not
	// projected to keep payload small.
	FlowCount      int `json:"flowCount"`
	PendingCount   int `json:"pendingCount"`
	RunningCount   int `json:"runningCount"`
	CompletedCount int `json:"completedCount"`
	FailedCount    int `json:"failedCount"`
	TerminatedCount int `json:"terminatedCount"`
	UnknownCount   int `json:"unknownCount"`
}

func ListVolcanoJobFlows(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Query("namespace")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "flow.volcano.sh",
			Version:       "v1alpha1",
			Kind:          "JobFlow",
			Namespace:     namespace,
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=JobFlow", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]jobFlowRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			status := mapOf(it["status"])
			state := mapOf(status["state"])
			out = append(out, jobFlowRow{
				Name:              str(meta["name"]),
				Namespace:         str(meta["namespace"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				Phase:             str(state["phase"]),
				JobRetainPolicy:   str(spec["jobRetainPolicy"]),
				FlowCount:         len(sliceOf(spec["flows"])),
				PendingCount:      len(sliceOf(status["pendingJobs"])),
				RunningCount:      len(sliceOf(status["runningJobs"])),
				CompletedCount:    len(sliceOf(status["completedJobs"])),
				FailedCount:       len(sliceOf(status["failedJobs"])),
				TerminatedCount:   len(sliceOf(status["terminatedJobs"])),
				UnknownCount:      len(sliceOf(status["unKnowJobs"])),
			})
		}
		c.JSON(http.StatusOK, volcanoListResponse[jobFlowRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// ─── JobTemplate (flow.volcano.sh/v1alpha1) ────────────────────────────

type jobTemplateRow struct {
	Name              string `json:"name"`
	Namespace         string `json:"namespace"`
	UID               string `json:"uid"`
	CreationTimestamp string `json:"creationTimestamp"`
	Queue             string `json:"queue,omitempty"`
	SchedulerName     string `json:"schedulerName,omitempty"`
	MinAvailable      int64  `json:"minAvailable"`
	TaskCount         int    `json:"taskCount"`
	PriorityClassName string `json:"priorityClassName,omitempty"`
}

func ListVolcanoJobTemplates(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Query("namespace")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "flow.volcano.sh",
			Version:       "v1alpha1",
			Kind:          "JobTemplate",
			Namespace:     namespace,
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=JobTemplate", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]jobTemplateRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			// JobTemplate's spec inlines a JobSpec — but the kubebuilder
			// scaffolding actually stores it directly under spec (no
			// jobSpec wrapper), so read like a Job's spec.
			spec := mapOf(it["spec"])
			out = append(out, jobTemplateRow{
				Name:              str(meta["name"]),
				Namespace:         str(meta["namespace"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				Queue:             str(spec["queue"]),
				SchedulerName:     str(spec["schedulerName"]),
				MinAvailable:      int64Of(spec["minAvailable"]),
				TaskCount:         len(sliceOf(spec["tasks"])),
				PriorityClassName: str(spec["priorityClassName"]),
			})
		}
		c.JSON(http.StatusOK, volcanoListResponse[jobTemplateRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// ─── Numatopology (nodeinfo.volcano.sh/v1alpha1) ───────────────────────

// numaResourceRow surfaces one entry of spec.numares (per-resource
// NUMA capacity/allocatable). UI renders these as a small badge per
// resource so users see the NUMA pool at a glance.
type numaResourceRow struct {
	Name        string `json:"name"`
	Allocatable string `json:"allocatable,omitempty"`
	Capacity    int64  `json:"capacity"`
}

type numatopologyRow struct {
	Name              string                  `json:"name"`
	UID               string                  `json:"uid"`
	CreationTimestamp string                  `json:"creationTimestamp"`
	Policies          map[string]string       `json:"policies,omitempty"`
	ResReserved       map[string]string       `json:"resReserved,omitempty"`
	NumaResources     []numaResourceRow       `json:"numaResources,omitempty"`
	CPUCount          int                     `json:"cpuCount"`
}

func ListVolcanoNumatopologies(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "nodeinfo.volcano.sh",
			Version:       "v1alpha1",
			Kind:          "Numatopology",
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=Numatopology", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]numatopologyRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			cpuDetail := mapOf(spec["cpuDetail"])
			out = append(out, numatopologyRow{
				Name:              str(meta["name"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				Policies:          stringMap(spec["policies"]),
				ResReserved:       stringMap(spec["resReserved"]),
				NumaResources:     numaResourcesOf(spec["numares"]),
				CPUCount:          len(cpuDetail),
			})
		}
		c.JSON(http.StatusOK, volcanoListResponse[numatopologyRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// numaResourcesOf flattens spec.numares (resourceName → ResourceInfo)
// into a stable list the UI can render row-by-row.
func numaResourcesOf(v any) []numaResourceRow {
	m, ok := v.(map[string]any)
	if !ok || len(m) == 0 {
		return nil
	}
	out := make([]numaResourceRow, 0, len(m))
	for name, raw := range m {
		ri := mapOf(raw)
		out = append(out, numaResourceRow{
			Name:        name,
			Allocatable: str(ri["allocatable"]),
			Capacity:    int64Of(ri["capacity"]),
		})
	}
	return out
}

// ─── NodeShard (shard.volcano.sh/v1alpha1) ─────────────────────────────

type nodeShardRow struct {
	Name              string   `json:"name"`
	UID               string   `json:"uid"`
	CreationTimestamp string   `json:"creationTimestamp"`
	NodesDesired      []string `json:"nodesDesired,omitempty"`
	NodesInUse        []string `json:"nodesInUse,omitempty"`
	NodesToAdd        []string `json:"nodesToAdd,omitempty"`
	NodesToRemove     []string `json:"nodesToRemove,omitempty"`
	LastUpdateTime    string   `json:"lastUpdateTime,omitempty"`
}

func ListVolcanoNodeShards(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "shard.volcano.sh",
			Version:       "v1alpha1",
			Kind:          "NodeShard",
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=NodeShard", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]nodeShardRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			status := mapOf(it["status"])
			out = append(out, nodeShardRow{
				Name:              str(meta["name"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				NodesDesired:      stringSlice(spec["nodesDesired"]),
				NodesInUse:        stringSlice(status["nodesInUse"]),
				NodesToAdd:        stringSlice(status["nodesToAdd"]),
				NodesToRemove:     stringSlice(status["nodesToRemove"]),
				LastUpdateTime:    str(status["lastUpdateTime"]),
			})
		}
		c.JSON(http.StatusOK, volcanoListResponse[nodeShardRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// stringSlice safely projects a []any of strings into []string,
// dropping non-string entries (defensive — the API server schema
// constrains items to strings, but unstructured decode loses that
// type info).
func stringSlice(v any) []string {
	s, ok := v.([]any)
	if !ok || len(s) == 0 {
		return nil
	}
	out := make([]string, 0, len(s))
	for _, item := range s {
		if str, ok := item.(string); ok && str != "" {
			out = append(out, str)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ─── ColocationConfiguration (config.volcano.sh/v1alpha1) ──────────────

type colocationConfigurationRow struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace"`
	UID               string            `json:"uid"`
	CreationTimestamp string            `json:"creationTimestamp"`
	HighRatio         int64             `json:"highRatio"`
	LowRatio          int64             `json:"lowRatio"`
	MinRatio          int64             `json:"minRatio"`
	// Stringified selector summary like "app=web" — the actual
	// LabelSelector shape is complex (matchExpressions + matchLabels);
	// the row projects only the matchLabels into "k=v" pairs joined
	// by comma. Full structure available via the Describe drawer.
	SelectorSummary string `json:"selectorSummary,omitempty"`
	// Status condition snapshot — pick the latest type=Available
	// status. Empty when the controller hasn't reconciled yet.
	Available string `json:"available,omitempty"`
}

func ListVolcanoColocationConfigurations(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Query("namespace")
		limit, cont := parseListParams(c)
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:        "list-full",
			Group:         "config.volcano.sh",
			Version:       "v1alpha1",
			Kind:          "ColocationConfiguration",
			Namespace:     namespace,
			Limit:         limit,
			ContinueToken: cont,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) {
				log.Printf("[handler] volcano CRD not available: cluster=%s kind=ColocationConfiguration", clusterID)
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		items, contNext, remaining, err := unstructuredItems(resp.Data)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		out := make([]colocationConfigurationRow, 0, len(items))
		for _, it := range items {
			meta := metaOf(it)
			spec := mapOf(it["spec"])
			memQos := mapOf(spec["memoryQos"])
			out = append(out, colocationConfigurationRow{
				Name:              str(meta["name"]),
				Namespace:         str(meta["namespace"]),
				UID:               str(meta["uid"]),
				CreationTimestamp: str(meta["creationTimestamp"]),
				HighRatio:         int64Of(memQos["highRatio"]),
				LowRatio:          int64Of(memQos["lowRatio"]),
				MinRatio:          int64Of(memQos["minRatio"]),
				SelectorSummary:   selectorSummary(spec["selector"]),
				Available:         latestCondition(it["status"], "Available"),
			})
		}
		c.JSON(http.StatusOK, volcanoListResponse[colocationConfigurationRow]{
			Items:              out,
			Continue:           contNext,
			RemainingItemCount: remaining,
		})
	}
}

// selectorSummary collapses a LabelSelector's matchLabels into a
// "k=v,k=v" string. matchExpressions is intentionally ignored — the
// table cell stays compact; users wanting the full structure click
// through to Describe.
func selectorSummary(v any) string {
	sel := mapOf(v)
	if len(sel) == 0 {
		return ""
	}
	labels := mapOf(sel["matchLabels"])
	if len(labels) == 0 {
		// Even if matchExpressions is set, surface a placeholder so
		// the cell isn't empty (otherwise the user can't tell whether
		// the selector is absent vs just expressions-only).
		if len(sliceOf(sel["matchExpressions"])) > 0 {
			return "(matchExpressions only)"
		}
		return ""
	}
	pairs := make([]string, 0, len(labels))
	for k, raw := range labels {
		if v, ok := raw.(string); ok {
			pairs = append(pairs, k+"="+v)
		}
	}
	if len(pairs) == 0 {
		return ""
	}
	// Sort for stable rendering across refreshes — unstructured map
	// iteration order is non-deterministic in Go.
	sort.Strings(pairs)
	return strings.Join(pairs, ",")
}

// latestCondition picks the Status of the most recent condition of
// the given type, or "" if none. Used to surface a single status
// string in the list row without dumping the whole conditions array.
func latestCondition(rawStatus any, condType string) string {
	status := mapOf(rawStatus)
	conds := sliceOf(status["conditions"])
	var latestTime, latestStatus string
	for _, c := range conds {
		cm := mapOf(c)
		if str(cm["type"]) != condType {
			continue
		}
		t := str(cm["lastTransitionTime"])
		// String compare works for RFC3339-formatted timestamps that
		// share a fixed-width layout — newer > older lexicographically.
		if t >= latestTime {
			latestTime = t
			latestStatus = str(cm["status"])
		}
	}
	return latestStatus
}

// ─── helpers ───────────────────────────────────────────────────────────

// unstructuredItems parses an `*UnstructuredList` JSON-marshalled by
// the worker and returns the .items array plus the list metadata that
// supports cursor pagination (continue token + remainingItemCount).
// Without these the frontend can't tell when a list got truncated by
// the server-side limit.
func unstructuredItems(raw []byte) ([]map[string]any, string, *int64, error) {
	var list struct {
		Items    []map[string]any `json:"items"`
		Metadata struct {
			Continue           string `json:"continue"`
			RemainingItemCount *int64 `json:"remainingItemCount"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, "", nil, fmt.Errorf("decode list: %w", err)
	}
	return list.Items, list.Metadata.Continue, list.Metadata.RemainingItemCount, nil
}

// metaOf safely pulls an object's metadata map.
func metaOf(obj map[string]any) map[string]any { return mapOf(obj["metadata"]) }

func mapOf(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func sliceOf(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// int64Of accepts JSON numbers (which decode to float64 in encoding/json
// or json.Number) and string-encoded integers (Quantity-like).
func int64Of(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	}
	return 0
}

// stringMap converts a Volcano resource map (string → string) into a
// plain Go map[string]string. K8s resource quantities are always
// strings on the wire.
func stringMap(v any) map[string]string {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, raw := range m {
		if s, ok := raw.(string); ok {
			out[k] = s
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// pluginNames extracts the keys of Volcano's `spec.plugins` map. The
// args (the values) are dropped — the UI only needs to surface which
// plugins are enabled.
func pluginNames(v any) []string {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	return names
}

// jobTasksOf flattens Volcano's spec.tasks[] into a slim shape the UI
// can render. Multi-container tasks expose only the first container's
// image — same convention the form drawer uses on the input side.
func jobTasksOf(tasks []any) []jobTaskRow {
	out := make([]jobTaskRow, 0, len(tasks))
	for _, t := range tasks {
		tm := mapOf(t)
		template := mapOf(tm["template"])
		spec := mapOf(template["spec"])
		containers := sliceOf(spec["containers"])
		image := ""
		if len(containers) > 0 {
			image = str(mapOf(containers[0])["image"])
		}
		out = append(out, jobTaskRow{
			Name:     str(tm["name"]),
			Replicas: int64Of(tm["replicas"]),
			Image:    image,
		})
	}
	return out
}

// extractSelector produces a "kind=value" string from a HyperNode
// member's selector union (exactMatch | regexMatch | labelMatch).
// Returned verbatim to the UI which renders it as-is.
func extractSelector(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	if em := mapOf(m["exactMatch"]); len(em) > 0 {
		return "exact: " + str(em["name"])
	}
	if rm := mapOf(m["regexMatch"]); len(rm) > 0 {
		return "regex: " + str(rm["pattern"])
	}
	if lm := mapOf(m["labelMatch"]); len(lm) > 0 {
		labels, _ := json.Marshal(lm["matchLabels"])
		return "labels: " + string(labels)
	}
	return ""
}
