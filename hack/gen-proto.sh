#!/bin/bash
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROTO_DIR="$ROOT/proto"
OUT_DIR="$ROOT/pkg/common/proto"

export PATH="$PATH:$(go env GOPATH)/bin"

# v1 — original bidi-gRPC transport. Generated into pkg/common/proto/.
# (`paths=source_relative` writes pilot.pb.go next to its .proto file's
# path relative to --proto_path, so proto/pilot.proto lands at
# OUT_DIR/pilot.pb.go.)
protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$OUT_DIR" \
  --go_opt=paths=source_relative \
  --go-grpc_out="$OUT_DIR" \
  --go-grpc_opt=paths=source_relative \
  "$PROTO_DIR"/pilot.proto

# v2 — yamux transport (docs/transport-v2.md). Generated into
# pkg/common/proto/v2/. No grpc service in v2 (pure messages), so
# --go-grpc_out emits a near-empty file — kept anyway for shape
# consistency, gives a single regen path for both transports.
# Phase D will delete v1 once the migration is done.
protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$OUT_DIR" \
  --go_opt=paths=source_relative \
  --go-grpc_out="$OUT_DIR" \
  --go-grpc_opt=paths=source_relative \
  "$PROTO_DIR"/v2/pilot.proto

echo "Proto generated to $OUT_DIR (v1) + $OUT_DIR/v2 (v2)"
