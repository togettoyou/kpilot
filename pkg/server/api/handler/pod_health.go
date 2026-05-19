// Package handler — pod-health snapshot for the Monitoring page.
//
// Restart counts and OOM events are counter-style metrics that are
// best surfaced as a "top-N problematic pods" table, not a time
// series. A dedicated endpoint keeps pod_metrics' range-query
// machinery clean and lets this handler bypass the response cache
// (the data is already cheap — two instant PromQL queries).
package handler

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

type podHealthRow struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Restarts  int64  `json:"restarts"`
	OOMs      int64  `json:"ooms"`
}

type podHealthResponse struct {
	GeneratedAt string         `json:"generatedAt"`
	Namespace   string         `json:"namespace,omitempty"`
	Rows        []podHealthRow `json:"rows"`
}

// GetPodHealth serves /api/v1/clusters/:id/pod-health?namespace=…&limit=…
//
// Fans out two PromQL instant queries (restart counter + OOM counter),
// merges the results into a single (namespace, pod) row table, and
// sorts by restart count desc then OOM count desc. Limit defaults to
// 20, max 100 (same shape as pod_metrics).
func GetPodHealth(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		ns := c.Query("namespace")
		limit := 20
		if s := c.Query("limit"); s != "" {
			if v, err := strconv.Atoi(s); err == nil && v > 0 && v <= 100 {
				limit = v
			}
		}

		vmURL, code, err := resolveVMQueryURL(gw, clusterID)
		if err != nil {
			if code != "" {
				if code == CodePluginNotFound || code == CodePluginNotEnabled || code == CodePluginNotRunning {
					apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
					return
				}
				apiErr(c, http.StatusServiceUnavailable, code)
				return
			}
			apiErrInternal(c, err)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), vmTimeout)
		defer cancel()

		cacheKey := vmCacheKey("pod-health", clusterID, ns+"|"+strconv.Itoa(limit))
		body, err := sharedVMResponseCache.GetOrCompute(cacheKey, 4*time.Second, func() (any, error) {

			nsFilter := ""
			if ns != "" {
				nsFilter = `,namespace="` + ns + `"`
			}
			// Restarts: kube_pod_container_status_restarts_total is the
			// canonical counter from kube-state-metrics. Sum across
			// containers per pod so the row reflects the whole pod
			// instead of one container.
			restartQ := `sum by (namespace, pod) (kube_pod_container_status_restarts_total{pod!=""` + nsFilter + `})`
			// OOMs: container_oom_events_total comes from cAdvisor. Same
			// per-pod rollup.
			oomQ := `sum by (namespace, pod) (container_oom_events_total{pod!=""` + nsFilter + `})`

			var (
				mu       sync.Mutex
				wg       sync.WaitGroup
				restarts = make(map[string]int64)
				ooms     = make(map[string]int64)
			)
			fetch := func(promql string, dst map[string]int64, tag string) {
				defer wg.Done()
				series, err := queryVM(ctx, gw, clusterID, vmURL, promql)
				if err != nil {
					logSoftErr("pod-health", clusterID, tag, err)
					return
				}
				mu.Lock()
				for _, s := range series {
					ns := s.Labels["namespace"]
					pod := s.Labels["pod"]
					if pod == "" {
						continue
					}
					dst[ns+"/"+pod] = int64(s.Value)
				}
				mu.Unlock()
			}
			wg.Add(2)
			go fetch(restartQ, restarts, "restarts")
			go fetch(oomQ, ooms, "ooms")
			wg.Wait()

			// Union the keys so a pod with restarts but no OOMs (or vice
			// versa) still shows up.
			keys := make(map[string]struct{}, len(restarts)+len(ooms))
			for k := range restarts {
				keys[k] = struct{}{}
			}
			for k := range ooms {
				keys[k] = struct{}{}
			}

			rows := make([]podHealthRow, 0, len(keys))
			for k := range keys {
				r := restarts[k]
				o := ooms[k]
				if r == 0 && o == 0 {
					continue
				}
				// Split "namespace/pod" back into parts. Pod names can't
				// contain "/" so the first separator is unambiguous.
				i := indexByte(k, '/')
				if i < 0 {
					continue
				}
				rows = append(rows, podHealthRow{
					Namespace: k[:i],
					Pod:       k[i+1:],
					Restarts:  r,
					OOMs:      o,
				})
			}
			// Sort: restart count desc, then OOM count desc, then name
			// for stable order.
			sort.SliceStable(rows, func(i, j int) bool {
				if rows[i].Restarts != rows[j].Restarts {
					return rows[i].Restarts > rows[j].Restarts
				}
				if rows[i].OOMs != rows[j].OOMs {
					return rows[i].OOMs > rows[j].OOMs
				}
				return rows[i].Namespace+"/"+rows[i].Pod < rows[j].Namespace+"/"+rows[j].Pod
			})
			if len(rows) > limit {
				rows = rows[:limit]
			}

			return podHealthResponse{
				GeneratedAt: time.Now().UTC().Format(time.RFC3339),
				Namespace:   ns,
				Rows:        rows,
			}, nil
		})
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.Data(http.StatusOK, "application/json", body)
	}
}

// indexByte is a tiny strings.IndexByte replacement so this file
// doesn't need the strings import for one call.
func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
