# KPilot Deployment

This directory contains everything needed to ship KPilot to a real
cluster:

```
deploy/
├── chart/                # Single Helm chart — Server, Worker, or both
├── server/Dockerfile     # Multi-stage build for the Server image
└── worker/Dockerfile     # Multi-stage build for the Worker image
```

GitHub Actions (`.github/workflows/release.yml`) ships every build
to GHCR:

| Trigger | Images | Chart |
|---|---|---|
| push to `main` | `:dev` | `0.0.0-dev` (app=dev, in-place overwrite) |
| `v*` tag | `:vX.Y.Z` + `:latest` | `X.Y.Z` (app=X.Y.Z) |
| manual dispatch | `:<input>` | `<input>` |

The `0.0.0-dev` chart channel tracks the head of `main` and is
overwritten on every push — handy for testing the latest unreleased
build (`helm install --version 0.0.0-dev`). Tagged releases produce
immutable chart versions.

## Topologies

All examples below use the published OCI chart. To install from a
local checkout instead (development / customization), point
`helm install` at `deploy/chart` and run `helm dependency build` first.

### Single-cluster (evaluation)

Server, Worker, and PostgreSQL all in one cluster. Useful for kind /
minikube smoke tests.

```bash
helm install kpilot oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.1.0 \
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
helm install kpilot oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.1.0 \
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
helm install kpilot-worker oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.1.0 \
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
helm install kpilot oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.1.0 \
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
helm upgrade kpilot oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.2.0 \
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

## Artifacts

| Artifact | Source | Tags |
|---|---|---|
| `ghcr.io/<owner>/kpilot-server` (image) | `deploy/server/Dockerfile` | `:dev` (main), `:vX.Y.Z` + `:latest` (release tag) |
| `ghcr.io/<owner>/kpilot-worker` (image) | `deploy/worker/Dockerfile` | same |
| `oci://ghcr.io/<owner>/charts/kpilot` (Helm) | `deploy/chart/` | `X.Y.Z` (release tag only) |

Images are multi-arch (linux/amd64, linux/arm64) on a distroless base.
The Server image bakes the built frontend at `/app/web` and serves it
as SPA static fallback when `STATIC_DIR` points there (the chart sets
the env automatically).

Helm chart releases happen on `v*` tags only — `main` pushes update
the `:dev` images but do not republish the chart, so the OCI registry
stays clean of unreleased versions.

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
