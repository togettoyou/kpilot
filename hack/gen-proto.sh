#!/bin/bash
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROTO_DIR="$ROOT/proto"
OUT_DIR="$ROOT/pkg/common/proto"

export PATH="$PATH:$(go env GOPATH)/bin"

protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$OUT_DIR" \
  --go_opt=paths=source_relative \
  --go-grpc_out="$OUT_DIR" \
  --go-grpc_opt=paths=source_relative \
  "$PROTO_DIR"/*.proto

echo "Proto generated to $OUT_DIR"
