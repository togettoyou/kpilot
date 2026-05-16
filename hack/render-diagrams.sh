#!/usr/bin/env bash
# Render every *.d2 and *.puml source under docs/assets into a sibling
# *.svg by POSTing to kroki.io. Re-run whenever a source changes; the
# SVG is checked into the repo so contributors don't need a local D2
# / PlantUML toolchain to view diagrams.
#
# Diagram-type mapping:
#   *.d2   → kroki d2 renderer
#   *.puml → kroki plantuml renderer (C4-PlantUML stdlib already bundled)
set -euo pipefail

KROKI="${KROKI:-https://kroki.io}"
ASSETS_DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/assets"

render_one() {
  local src=$1 kind=$2
  local out="${src%.*}.svg"
  echo "▸ $src → $out  ($kind)"
  if ! curl -sf -X POST "$KROKI/$kind/svg" \
        -H 'Content-Type: text/plain' \
        --data-binary "@$src" \
        -o "$out"; then
    echo "  kroki render failed for $src" >&2
    return 1
  fi
}

shopt -s nullglob
found=0
for src in "$ASSETS_DIR"/*.d2; do
  render_one "$src" d2
  found=1
done
for src in "$ASSETS_DIR"/*.puml; do
  render_one "$src" plantuml
  found=1
done

if [[ $found -eq 0 ]]; then
  echo "no diagram sources found under $ASSETS_DIR"
  exit 0
fi
echo "all diagrams rendered."
