# KPilot Deployment

This directory contains everything needed to ship KPilot to a real
cluster:

```
deploy/
├── chart/                # Single Helm chart — Server, Worker, or both
├── server/Dockerfile     # Multi-stage build for the Server image
└── worker/Dockerfile     # Multi-stage build for the Worker image
```

GitHub Actions (`.github/workflows/release.yml`) builds and pushes
both images to `ghcr.io/<owner>/kpilot-{server,worker}` on every push
to `main` (`:dev` tag) and every `v*` tag (`:vX.Y.Z` + `:latest`).

## Topologies

### Single-cluster (evaluation)

Server, Worker, and PostgreSQL all in one cluster. Useful for kind /
minikube smoke tests.

```bash
helm dependency build deploy/chart
helm install kpilot deploy/chart \
  --namespace kpilot-system --create-namespace \
  --set worker.enabled=true \
  --set worker.serverAddr='kpilot-server-grpc.kpilot-system.svc:9090' \
  --set worker.clusterToken='<token-from-ui>'
```

### Production: Server in one cluster, Workers in many

This is the intended deployment shape.

**Control-plane cluster** — install the Server with bundled Postgres
(or an external one), expose the HTTP + gRPC services:

```bash
helm install kpilot deploy/chart \
  --namespace kpilot-system --create-namespace \
  --set server.admin.password='<rotate-me>' \
  --set server.jwtSecret='<random-64-bytes>' \
  --set server.corsOrigins='{https://kpilot.example.com}' \
  --set server.ingress.enabled=true \
  --set server.ingress.hosts[0].host=kpilot.example.com \
  --set server.ingress.hosts[0].paths[0].path=/ \
  --set server.ingress.hosts[0].paths[0].pathType=Prefix
```

**Each managed cluster** — install only the Worker, pointed at the
Server's gRPC endpoint, with a one-time ClusterToken from the UI:

```bash
helm install kpilot-worker deploy/chart \
  --namespace kpilot-system --create-namespace \
  --set server.enabled=false \
  --set worker.enabled=true \
  --set postgresql.enabled=false \
  --set worker.serverAddr='kpilot-grpc.example.com:443' \
  --set worker.clusterToken='<paste-token>'
```

`worker.serverAddr` must be reachable from inside the Worker Pod. If
the Server's gRPC Service is exposed via an L7 gateway that strips TLS,
the address is `<host>:443`. For a LoadBalancer-type Service the
address is `<lb-ip>:9090`.

## External PostgreSQL

To skip the bundled Postgres and point the Server at a managed
database (RDS, CloudSQL, Crunchy, etc.):

```bash
helm install kpilot deploy/chart \
  --namespace kpilot-system --create-namespace \
  --set postgresql.enabled=false \
  --set server.postgresql.externalDsn='postgres://kpilot:<pw>@db.example.com:5432/kpilot?sslmode=require'
```

The Server expects standard libpq DSN syntax. `sslmode=require` is
recommended for any non-local Postgres; the chart does not enforce
it because some on-prem deployments terminate TLS at a sidecar.

## Upgrade

`helm upgrade` rolls the Deployment in place. The chart pins images
to `Chart.AppVersion` by default, so bumping the chart version is the
upgrade path:

```bash
helm upgrade kpilot deploy/chart \
  --namespace kpilot-system \
  --reuse-values
```

Server admin / JWT secrets are stored in a managed Secret. The chart
re-reads existing JWT secrets on upgrade (via Helm's `lookup`), so
tokens stay valid across rolling deploys. Admin password rotation is
explicit — pass `--set server.admin.password=...` to change it.

## Uninstall

```bash
helm uninstall kpilot --namespace kpilot-system
```

PVCs left behind by the bundled PostgreSQL are NOT removed by Helm
(by design — accidental data loss). Drop them manually if a clean
re-install is desired:

```bash
kubectl -n kpilot-system delete pvc -l app.kubernetes.io/name=postgresql
kubectl -n kpilot-system delete pvc -l app.kubernetes.io/component=worker
```

## Images

| Image | Source | Tags |
|---|---|---|
| `ghcr.io/<owner>/kpilot-server` | `deploy/server/Dockerfile` | `:dev` (main), `:vX.Y.Z` + `:latest` (release tag) |
| `ghcr.io/<owner>/kpilot-worker` | `deploy/worker/Dockerfile` | same |

Both are multi-arch (linux/amd64, linux/arm64) and built on a
distroless base. The Server image bakes the built frontend at
`/app/web` and serves it as SPA static fallback when `STATIC_DIR`
points there (the chart sets the env automatically).

Building locally:

```bash
docker buildx build \
  -f deploy/server/Dockerfile \
  -t kpilot-server:local \
  --build-arg VERSION=local \
  --load .

docker buildx build \
  -f deploy/worker/Dockerfile \
  -t kpilot-worker:local \
  --build-arg VERSION=local \
  --load .
```
