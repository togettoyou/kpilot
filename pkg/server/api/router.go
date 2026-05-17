package api

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/api/handler"
	"github.com/togettoyou/kpilot/pkg/server/api/middleware"
	"github.com/togettoyou/kpilot/pkg/server/config"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

func NewRouter(cfg *config.Config, gw *gateway.GatewayServer) *gin.Engine {
	r := gin.Default()

	// Build origin lookup set once.
	allowedOrigins := make(map[string]struct{}, len(cfg.CORSOrigins))
	for _, o := range cfg.CORSOrigins {
		allowedOrigins[o] = struct{}{}
	}
	devMode := len(allowedOrigins) == 0

	// Mirror the CORS allow-list into the handler package so the
	// WebSocket upgraders use the same policy. Without this, the
	// upgraders fall back to `return true` and accept cross-site WS
	// handshakes — letting an attacker page hijack Grafana / Pod
	// exec / Pod logs sessions via the browser's auto-attached cookie.
	handler.SetCORSOrigins(cfg.CORSOrigins)
	// Propagate the "default admin password" flag so /auth/me surfaces
	// it to the frontend as mustRotatePassword and the user sees a
	// rotation banner. Set once at boot — package-level setter pairs
	// with SetCORSOrigins.
	handler.SetAdminPasswordIsDefault(cfg.AdminPasswordIsDefault)

	r.Use(func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			_, allowed := allowedOrigins[origin]
			if devMode || allowed {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Access-Control-Allow-Credentials", "true")
				c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
				c.Header("Access-Control-Max-Age", "86400")
			}
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	api := r.Group("/api/v1")
	{
		// Public — version banner shown in the UI header.
		api.GET("/version", handler.Version())

		auth := api.Group("/auth")
		auth.POST("/login", handler.Login(cfg.AdminUsername, cfg.AdminPassword, cfg.JWTSecret))
		auth.POST("/logout", handler.Logout())
		auth.GET("/me", middleware.Auth(cfg.JWTSecret), handler.Me())
		// Public: lets the login page show a seed-credentials hint when
		// the deployment hasn't rotated ADMIN_PASSWORD yet.
		auth.GET("/defaults", handler.Defaults(cfg.AdminUsername, cfg.AdminPassword))
	}

	protected := api.Group("", middleware.Auth(cfg.JWTSecret))
	{
		clusters := protected.Group("/clusters")
		clusters.POST("", handler.CreateCluster)
		clusters.GET("", handler.ListClusters)
		clusters.PATCH("/:id", handler.UpdateCluster)
		clusters.DELETE("/:id", handler.DeleteCluster)
		clusters.POST("/:id/token", handler.RegenerateToken(gw))
		// Node listing/get goes through the workloads proxy (/workloads/nodes,
		// /workloads/nodes/:name) — same Table API path kubectl uses.
		// Cordon/uncordon has its own scoped endpoint instead of going
		// through the generic /workloads PUT, so the Server can tightly
		// constrain the patch body to just spec.unschedulable.
		clusters.POST("/:id/workloads/nodes/:name/cordon", handler.CordonNode(gw))
		clusters.GET("/:id/namespaces", handler.ListNamespaces(gw))
		clusters.GET("/:id/workloads/:type", handler.ListWorkloads(gw))
		clusters.GET("/:id/workloads/:type/:name", handler.GetWorkload(gw))
		clusters.GET("/:id/workloads/:type/:name/describe", handler.DescribeWorkload(gw))
		clusters.PUT("/:id/workloads/:type/:name", handler.ApplyWorkload(gw))
		clusters.DELETE("/:id/workloads/:type/:name", handler.DeleteWorkload(gw))
		clusters.POST("/:id/apply", handler.ApplyYAML(gw))
		clusters.POST("/:id/delete-yaml", handler.DeleteYAML(gw))

		// Pod streaming endpoints (WebSocket). Auth is the same JWT cookie —
		// browsers send cookies on the WS handshake, so the Auth middleware
		// above runs first and rejects unauthenticated upgrades.
		clusters.GET("/:id/pods/:namespace/:name/logs", handler.PodLogs(gw))
		clusters.GET("/:id/pods/:namespace/:name/exec", handler.PodExec(gw))
		// Realtime CPU/memory snapshot from the Metrics API (metrics.k8s.io).
		// Sits under /pods/ — same prefix as logs/exec — to avoid sharing a
		// path level with the generic /workloads/:type tree (a static "pods"
		// segment there would shadow :type and break PUT/DELETE/GET-yaml on
		// pods).
		clusters.GET("/:id/pods/:namespace/:name/top", handler.TopPod(gw))

		// Volcano-dedicated list endpoints. Per-kind handlers fetch full
		// objects via the worker's list-full action and project the
		// fields the 算力调度 UI needs into a slim shape — one
		// round-trip instead of the generic Table-API + per-row GETs.
		clusters.GET("/:id/volcano/queues", handler.ListVolcanoQueues(gw))
		clusters.GET("/:id/volcano/jobs", handler.ListVolcanoJobs(gw))
		clusters.GET("/:id/volcano/cronjobs", handler.ListVolcanoCronJobs(gw))
		clusters.GET("/:id/volcano/podgroups", handler.ListVolcanoPodGroups(gw))
		clusters.GET("/:id/volcano/hypernodes", handler.ListVolcanoHyperNodes(gw))
		clusters.GET("/:id/volcano/jobflows", handler.ListVolcanoJobFlows(gw))
		clusters.GET("/:id/volcano/jobtemplates", handler.ListVolcanoJobTemplates(gw))
		clusters.GET("/:id/volcano/numatopologies", handler.ListVolcanoNumatopologies(gw))
		clusters.GET("/:id/volcano/nodeshards", handler.ListVolcanoNodeShards(gw))
		clusters.GET("/:id/volcano/colocationconfigurations", handler.ListVolcanoColocationConfigurations(gw))

		// Cluster vGPU snapshot — synthetic endpoint that projects
		// Volcano vGPU annotations across all Nodes + Pods into a
		// single tree. 404 + RESOURCE_NOT_AVAILABLE when no nodes
		// registered, same pattern as the Volcano CR list endpoints.
		clusters.GET("/:id/vgpu", handler.GetVGPUSnapshot(gw))

		// Volcano installation status — cluster-side detection (CRD
		// + scheduler ConfigMap) so the frontend doesn't need to
		// gate on KPilot's plugin registry. Works for any install
		// path: KPilot plugin, kubectl apply, helm install outside
		// KPilot, sealos preinstall, etc.
		clusters.GET("/:id/volcano/status", handler.GetVolcanoStatus(gw))

		// Device health aggregator — reads DCGM XID / ECC / temp / FB
		// from VictoriaMetrics through the worker tunnel and rolls them
		// into a single alert list. RESOURCE_NOT_AVAILABLE if VM isn't
		// running on the cluster.
		clusters.GET("/:id/device-health", handler.GetDeviceHealth(gw))
		// GPU metrics for the custom monitoring page — six DCGM
		// range queries fanned out in parallel + a server-computed
		// "current" snapshot. Replaces the original Grafana iframe
		// approach so the /compute platform doesn't depend on the
		// generic dashboard plugin.
		clusters.GET("/:id/gpu-metrics", handler.GetGPUMetrics(gw))
		// GPU-Hour billing report — VM range query integrating
		// DCGM_FI_DEV_GPU_UTIL/100 over the requested window. Capped
		// at 30d to match the bundled victoria-metrics-single chart's
		// default retention.
		clusters.GET("/:id/gpu-hour", handler.GetGPUHour(gw))

		// Cluster Management → Monitoring page. Three handlers split
		// by drill-down level (cluster / node / pod) so the frontend
		// can poll each at its own cadence and degrade individually
		// when an exporter is missing.
		clusters.GET("/:id/cluster-metrics", handler.GetClusterMetrics(gw))
		clusters.GET("/:id/node-metrics", handler.GetNodeMetrics(gw))
		clusters.GET("/:id/pod-metrics", handler.GetPodMetrics(gw))
		// Pod health snapshot — restart + OOM counts as a top-N
		// table. Counter semantics; separate from /pod-metrics's
		// rate-style range queries.
		clusters.GET("/:id/pod-health", handler.GetPodHealth(gw))

		// Cluster Management → Logging page. Search (limited line
		// pull) + histogram (binned counts), both LogsQL through the
		// worker tunnel.
		clusters.GET("/:id/logs/search", handler.GetLogsSearch(gw))
		clusters.GET("/:id/logs/histogram", handler.GetLogsHistogram(gw))

		// Per-cluster plugin state (read-only registry view + enable/disable)
		clusters.GET("/:id/plugins", handler.ListClusterPlugins)
		clusters.POST("/:id/plugins/:name/enable", handler.EnablePlugin(gw))
		clusters.POST("/:id/plugins/:name/disable", handler.DisablePlugin(gw))
		// Real-time install / upgrade / uninstall log (WebSocket). Subscribes
		// to the gateway's per-(cluster, plugin) ring buffer; same JWT cookie
		// auth as everything else above.
		clusters.GET("/:id/plugins/:name/install-log", handler.PluginInstallLog(gw))

		// Reverse proxy to plugin-managed in-cluster Services. The browser
		// loads /api/v1/clusters/<id>/proxy/grafana/... and KPilot Server
		// forwards through the gRPC tunnel to the cluster's Grafana
		// Service. Auth lives in the JWT middleware above; the proxy
		// handler injects X-WEBAUTH-USER so the upstream sees a logged-in
		// session without ever asking for a password.
		//
		// `Any` covers GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS — Grafana's
		// API uses all of them.
		clusters.Any("/:id/proxy/:plugin/*path", handler.ProxyPlugin(gw))

		// In-process observability snapshot. Auth-protected (admin-only
		// in the single-tenant model). Returns JSON; not Prometheus text
		// format — this is a debug surface for the human operator.
		protected.GET("/metrics", handler.GetMetrics(gw))

		// Global plugin registry
		plugins := protected.Group("/plugins")
		plugins.GET("", handler.ListPlugins)
		plugins.POST("", handler.CreatePlugin)
		plugins.POST("/upload", handler.UploadPluginChart)
		plugins.GET("/:id", handler.GetPlugin)
		plugins.PATCH("/:id", handler.UpdatePlugin)
		plugins.DELETE("/:id", handler.DeletePlugin)
	}

	// SPA static fallback — only mounted when STATIC_DIR points at a
	// real directory with an index.html. In dev the frontend runs on
	// its own UmiJS port and proxies API calls back here, so STATIC_DIR
	// stays unset; in prod the Docker image bakes the built frontend
	// into /app/web and sets STATIC_DIR=/app/web. The NoRoute handler
	// serves index.html for any path that didn't match an API route
	// (or /health), letting the SPA's client-side router take over.
	mountSPA(r, cfg.StaticDir)

	return r
}

func mountSPA(r *gin.Engine, dir string) {
	if dir == "" {
		return
	}
	indexPath := filepath.Join(dir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		log.Printf("[router] STATIC_DIR=%s but index.html not found, skipping SPA mount: err=%v", dir, err)
		return
	}
	// Single NoRoute serves both static assets and the SPA fallback.
	// Umi/Max emits all hashed JS/CSS chunks flat at the dist root
	// (`/_c9fde89b.css`, `/_root-of-the-server___...js`, …) rather
	// than under a Vite/CRA-style `/assets/` subtree, so an inflexible
	// `r.Static("/assets", …)` mount would miss them entirely and the
	// browser would 200-with-HTML those .js requests → silent parse
	// failure → blank page. Walking the URL path against the dir
	// once per request stays simple AND covers exportStatic's
	// per-route subdirectories (`/clusters/index.html`, etc.) without
	// pre-registering every file at boot.
	r.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path
		// Real misses on the API surface stay 404 instead of being
		// silently rewritten to index.html — HTTP clients expect JSON,
		// not the SPA shell.
		if strings.HasPrefix(p, "/api/") || p == "/health" {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		// filepath.Clean drops `..` segments; defense-in-depth Rel
		// check rejects anything that resolves outside dir. Both
		// matter because `c.File` calls http.ServeFile which trusts
		// the path it gets.
		clean := filepath.Clean(p)
		fp := filepath.Join(dir, clean)
		if rel, err := filepath.Rel(dir, fp); err != nil || strings.HasPrefix(rel, "..") {
			c.AbortWithStatus(http.StatusBadRequest)
			return
		}
		if st, err := os.Stat(fp); err == nil && !st.IsDir() {
			c.File(fp)
			return
		}
		// Unmatched route → SPA history fallback. The client-side
		// router takes over from here.
		c.File(indexPath)
	})
	log.Printf("[router] SPA mounted: dir=%s", dir)
}
