# syntax=docker/dockerfile:1.7
#
# KPilot Worker image.
#
# The worker is a Kubernetes operator that dials back to the Server
# over TCP+TLS+yamux and brokers every cluster-side operation. It
# runs as a regular Deployment inside each managed cluster.
#
# DATA_DIR (default /var/lib/kpilot) holds the Helm chart cache and
# Helm SDK working files; chart releases that pull repo charts grow
# the cache, so the Helm chart in deploy/chart/ mounts a PVC there.

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS go-build
WORKDIR /work
# Vendored dependencies — `go build` auto-uses vendor/ when present,
# no network needed and no go mod download.
COPY go.mod go.sum ./
COPY vendor/ ./vendor/
COPY cmd/worker/ ./cmd/worker/
COPY pkg/ ./pkg/
COPY proto/ ./proto/
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
# Same rationale as server/Dockerfile: override the version variable
# in pkg/common/version (NOT main) so worker's WorkerVersion in the
# Register message reflects the CI image tag.
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath \
    -ldflags "-s -w -X github.com/togettoyou/kpilot/pkg/common/version.Version=$VERSION" \
    -o /work/worker ./cmd/worker

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=go-build /work/worker /app/worker
# DATA_DIR is writable, mounted from a PVC in the Helm chart.
ENV DATA_DIR=/var/lib/kpilot
USER nonroot:nonroot
ENTRYPOINT ["/app/worker"]
