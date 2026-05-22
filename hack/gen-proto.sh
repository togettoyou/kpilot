#!/bin/bash
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROTO_DIR="$ROOT/proto"
OUT_DIR="$ROOT/pkg/common/proto"

export PATH="$PATH:$(go env GOPATH)/bin"

# v2 transport (docs/transport-v2.md). v1 was retired in phase D
# of the migration; this is now the only schema. Pure messages —
# no gRPC service in v2 — but --go-grpc_out is still invoked so
# regen tooling stays uniform; it emits a near-empty *_grpc.pb.go.
protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$OUT_DIR" \
  --go_opt=paths=source_relative \
  --go-grpc_out="$OUT_DIR" \
  --go-grpc_opt=paths=source_relative \
  "$PROTO_DIR"/v2/pilot.proto

echo "Proto generated to $OUT_DIR/v2"
