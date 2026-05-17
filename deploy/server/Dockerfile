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

# node:24-alpine ships npm 11.x.
#
# We use `npm install` (not `npm ci`) on purpose: the UmiJS bundler
# pins a few transitive deps (less-loader, ajv, postcss) at exact
# versions while neighbour packages declare `^` ranges that resolve
# higher. `npm install` reconciles this at install time, the way the
# project lives locally. `npm ci` would EUSAGE because the lock
# stores both versions but can only validate one.
# --legacy-peer-deps mirrors the override behavior the React 19 +
# antd v6 stack needs to coexist with older Umi plugin peer ranges.
FROM --platform=$BUILDPLATFORM node:24-alpine AS web-build
WORKDIR /work
COPY web/package.json web/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund --legacy-peer-deps --prefer-offline
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS go-build
WORKDIR /work
# Vendored dependencies — `go build` auto-uses vendor/ when present,
# which means no network during this stage and no go mod download.
COPY go.mod go.sum ./
COPY vendor/ ./vendor/
COPY cmd/server/ ./cmd/server/
COPY pkg/ ./pkg/
COPY proto/ ./proto/
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
RUN --mount=type=cache,target=/root/.cache/go-build \
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
