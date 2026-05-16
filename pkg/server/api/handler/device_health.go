// Package handler — device health aggregator.
//
// Reads a small set of DCGM Exporter counters (XID, ECC, temperature,
// framebuffer-near-full) from VictoriaMetrics through the worker tunnel
// and rolls them up into a single sortable alert list rendered at
// /compute/:id/device-health.
//
// Why server-side rather than letting the frontend PromQL VM directly:
// (1) PromQL strings stay close to the alert semantics they encode and
// can be tuned without a frontend redeploy; (2) the proxy surface we
// expose to the browser stays Grafana-only — VM remains a server-side
// implementation detail; (3) future extensions (Volcano Job events,
// vGPU snapshot health, K8s node conditions) can be merged into the
// same response shape without changing the wire contract.
package handler

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// alertSeverity tracks the severity bucket the frontend uses for KPI
// counts and the row color. critical > warning > info; the frontend
// sort orders critical-first.
type alertSeverity string

const (
	severityCritical alertSeverity = "critical"
	severityWarning  alertSeverity = "warning"
	severityInfo     alertSeverity = "info"
)

// alertKind identifies what kind of device-health issue an entry
// represents. The frontend uses this for filter chips and the column
// "kind" cell — keep the set short and stable, add new kinds rather
// than mutating existing values.
type alertKind string

const (
	kindXIDError       alertKind = "xid_error"
	kindECCUncorrect   alertKind = "ecc_uncorrectable"
	kindOverheat       alertKind = "overheat"
	kindFBMemoryFull   alertKind = "fb_memory_near_full"
)

// deviceAlert is one row in the device-health table.
type deviceAlert struct {
	Severity alertSeverity     `json:"severity"`
	Kind     alertKind         `json:"kind"`
	// Hostname / instance / gpu come straight from DCGM labels and
	// double as the join keys for cross-page navigation: the frontend
	// links to /compute/:id/vgpu filtered by hostname (when present)
	// and to /compute/:id/gpu-monitoring filtered by instance/gpu.
	Hostname string  `json:"hostname,omitempty"`
	Instance string  `json:"instance,omitempty"`
	GPU      string  `json:"gpu,omitempty"`
	UUID     string  `json:"uuid,omitempty"`
	Value    float64 `json:"value"`
	// Human-friendly description ("XID 79 — GPU has fallen off the bus")
	// composed by the handler based on the kind + label values; the
	// frontend renders this directly without further interpretation so
	// adding a new kind doesn't require frontend i18n surgery.
	Message string `json:"message"`
}

type deviceHealthResponse struct {
	Alerts      []deviceAlert `json:"alerts"`
	GeneratedAt string        `json:"generatedAt"`
	// Severity counts pre-computed so the frontend KPI row doesn't have
	// to walk the list twice (once for render, once for counts).
	Counts struct {
		Critical int `json:"critical"`
		Warning  int `json:"warning"`
		Info     int `json:"info"`
	} `json:"counts"`
}

// GetDeviceHealth serves /api/v1/clusters/:id/device-health. The shape
// is "all alerts" — pagination would be premature for a fleet that
// would already be on fire if it had >100 active GPU faults.
func GetDeviceHealth(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")

		// VM must be enabled — without it there's no metric history to
		// query. RESOURCE_NOT_AVAILABLE so the frontend can swap to
		// <NotInstalled> with a "install VictoriaMetrics" CTA.
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

		alerts, err := collectDeviceAlerts(ctx, gw, clusterID, vmURL)
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		// Order critical → warning → info; within each bucket sort by
		// hostname then gpu so the table is stable across refreshes.
		sort.SliceStable(alerts, func(i, j int) bool {
			si, sj := severityRank(alerts[i].Severity), severityRank(alerts[j].Severity)
			if si != sj {
				return si < sj
			}
			if alerts[i].Hostname != alerts[j].Hostname {
				return alerts[i].Hostname < alerts[j].Hostname
			}
			return alerts[i].GPU < alerts[j].GPU
		})

		resp := deviceHealthResponse{
			Alerts:      alerts,
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		}
		for _, a := range alerts {
			switch a.Severity {
			case severityCritical:
				resp.Counts.Critical++
			case severityWarning:
				resp.Counts.Warning++
			case severityInfo:
				resp.Counts.Info++
			}
		}

		c.JSON(http.StatusOK, resp)
	}
}

func severityRank(s alertSeverity) int {
	switch s {
	case severityCritical:
		return 0
	case severityWarning:
		return 1
	case severityInfo:
		return 2
	}
	return 3
}

// collectDeviceAlerts runs all four health PromQL queries in parallel
// and normalizes their vector results into deviceAlerts. Each query
// failure is logged-and-tolerated so a single broken metric (e.g. ECC
// counters not yet populated on a fresh cluster) doesn't blackhole the
// page — the failing alert kind is simply omitted from the list.
func collectDeviceAlerts(ctx context.Context, gw *gateway.GatewayServer, clusterID, vmURL string) ([]deviceAlert, error) {
	type job struct {
		promql string
		fn     func(s vmSeries) deviceAlert
	}
	jobs := []job{
		{
			// XID errors: DCGM_FI_DEV_XID_ERRORS reports the most-recent
			// XID code observed per GPU. 0 means none; >0 is a hardware
			// fault. NVIDIA's XID catalog (CUDA toolkit docs) lists the
			// classifications; we don't try to enumerate them here.
			promql: `DCGM_FI_DEV_XID_ERRORS > 0`,
			fn: func(s vmSeries) deviceAlert {
				return deviceAlert{
					Severity: severityCritical,
					Kind:     kindXIDError,
					Hostname: s.Labels["Hostname"],
					Instance: s.Labels["instance"],
					GPU:      s.Labels["gpu"],
					UUID:     s.Labels["UUID"],
					Value:    s.Value,
					Message:  fmt.Sprintf("GPU reported XID %d — hardware fault, consult NVIDIA XID catalog", int(s.Value)),
				}
			},
		},
		{
			// Uncorrectable ECC errors over the last 30 minutes — DBE_VOL
			// is monotonic, so an increase > 0 means new uncorrectable
			// errors were observed. Window is wide enough that a quick
			// page open after an event still surfaces it.
			promql: `increase(DCGM_FI_DEV_ECC_DBE_VOL_TOTAL[30m]) > 0`,
			fn: func(s vmSeries) deviceAlert {
				return deviceAlert{
					Severity: severityCritical,
					Kind:     kindECCUncorrect,
					Hostname: s.Labels["Hostname"],
					Instance: s.Labels["instance"],
					GPU:      s.Labels["gpu"],
					UUID:     s.Labels["UUID"],
					Value:    s.Value,
					Message:  fmt.Sprintf("%g uncorrectable ECC errors in the last 30 minutes — data may be corrupted, plan to drain and reseat / RMA", s.Value),
				}
			},
		},
		{
			// Overheat — > 85°C is the threshold the bundled dashboard
			// marks red. NVIDIA spec slowdown threshold varies per SKU
			// (typically 87-90°C); 85 catches conditions before throttle.
			promql: `DCGM_FI_DEV_GPU_TEMP > 85`,
			fn: func(s vmSeries) deviceAlert {
				sev := severityWarning
				if s.Value >= 90 {
					sev = severityCritical
				}
				return deviceAlert{
					Severity: sev,
					Kind:     kindOverheat,
					Hostname: s.Labels["Hostname"],
					Instance: s.Labels["instance"],
					GPU:      s.Labels["gpu"],
					UUID:     s.Labels["UUID"],
					Value:    s.Value,
					Message:  fmt.Sprintf("GPU temperature %.0f°C — investigate cooling / airflow", s.Value),
				}
			},
		},
		{
			// FB memory near full — DCGM_FI_DEV_FB_USED is in MiB; pair
			// with FB_TOTAL to get a ratio. Threshold 95% catches the
			// case where the next allocator would OOM the job.
			promql: `(DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL) > 0.95`,
			fn: func(s vmSeries) deviceAlert {
				return deviceAlert{
					Severity: severityWarning,
					Kind:     kindFBMemoryFull,
					Hostname: s.Labels["Hostname"],
					Instance: s.Labels["instance"],
					GPU:      s.Labels["gpu"],
					UUID:     s.Labels["UUID"],
					Value:    s.Value,
					Message:  fmt.Sprintf("Framebuffer memory at %.0f%% — next allocation likely OOM", s.Value*100),
				}
			},
		},
	}

	var (
		out []deviceAlert
		mu  sync.Mutex
		wg  sync.WaitGroup
	)
	for _, j := range jobs {
		j := j
		wg.Add(1)
		go func() {
			defer wg.Done()
			series, err := queryVM(ctx, gw, clusterID, vmURL, j.promql)
			if err != nil {
				// Don't fail the whole response — log + skip. Common
				// reason: metric not yet populated (cluster just got
				// dcgm-exporter; ECC counter is zero from the start so
				// `increase()` returns no series rather than a value).
				log.Printf("[device-health] VM query failed: cluster=%s promql=%q err=%v",
					clusterID, j.promql, err)
				return
			}
			local := make([]deviceAlert, 0, len(series))
			for _, s := range series {
				local = append(local, j.fn(s))
			}
			mu.Lock()
			out = append(out, local...)
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out, nil
}
