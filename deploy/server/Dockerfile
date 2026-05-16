# syntax=docker/dockerfile:1.7
#
# KPilot Server image.
#
# Three stages:
#   1. web-build   — node:20 + npm ci + max build  → /work/dist
#   2. go-build    — golang:1.26 + go build         → /work/server
#   3. runtime     — distroless static + binary + frontend assets
#
# The frontend is served by the Go binary as a SPA fallback when
# STATIC_DIR is set (see pkg/server/api/router.go::mountSPA). Bundling
# both into a single container keeps the deployment story to one
# Deployment + one Service per cluster.

FROM --platform=$BUILDPLATFORM node:20-alpine AS web-build
WORKDIR /work
COPY web/package.json web/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS go-build
WORKDIR /work
# Pre-resolve modules so source edits don't bust the dep cache.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
# Bring in only what the server build needs. proto/ is required because
# go build pulls in generated stubs transitively.
COPY cmd/server ./cmd/server
COPY pkg/ ./pkg/
COPY proto/ ./proto/
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
    -o /work/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=go-build /work/server /app/server
COPY --from=web-build /work/dist /app/web
ENV STATIC_DIR=/app/web \
    HTTP_ADDR=:8080 \
    GRPC_ADDR=:9090
EXPOSE 8080 9090
USER nonroot:nonroot
ENTRYPOINT ["/app/server"]
