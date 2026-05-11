package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

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
	State             string            `json:"state"`
	Parent            string            `json:"parent,omitempty"`
	Reclaimable       *bool             `json:"reclaimable,omitempty"`
	Capability        map[string]string `json:"capability,omitempty"`
	Allocated         map[string]string `json:"allocated,omitempty"`
	Running           int64             `json:"running"`
	Pending           int64             `json:"pending"`
	Inqueue           int64             `json:"inqueue"`
	Completed         int64             `json:"completed"`
	Unknown           int64             `json:"unknown"`
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
				State:             str(status["state"]),
				Parent:            str(spec["parent"]),
				Capability:        stringMap(spec["capability"]),
				Allocated:         stringMap(status["allocated"]),
				Running:           int64Of(status["running"]),
				Pending:           int64Of(status["pending"]),
				Inqueue:           int64Of(status["inqueue"]),
				Completed:         int64Of(status["completed"]),
				Unknown:           int64Of(status["unknown"]),
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
