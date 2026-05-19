#!/usr/bin/env bash
# loadtest.sh — load-test KPilot HTTP endpoints via bombardier.
#
# Why bombardier (and not curl-in-a-loop): curl spawns a new process
# per request and opens a new TCP connection — on Windows that's
# ~20-50 ms of fork/exec + handshake overhead per call. At 100
# concurrent that overhead alone caps measured RPS around 40-50.
# bombardier uses keep-alive HTTP/1.1 over goroutine-managed
# connections, so it measures the server's actual ceiling instead of
# the client's overhead. We learned this the hard way — see the
# tunnel HA hardening commit for context.
#
# Install:  auto-installed via `go install` on first run; falls back
#           to GOPROXY=https://goproxy.cn,direct when the default
#           proxy is unreachable (most CN networks). If `go` itself
#           is missing the script prints platform-specific install
#           hints and exits.
#
# Usage:    loadtest.sh <subcommand> [args]
# Required env (or .env in cwd):
#   KPILOT_JWT      — auth cookie value (JWT, no `kpilot_token=` prefix)
#   KPILOT_HOST     — e.g. http://localhost:8080 or https://your-deploy
#   KPILOT_CID      — target cluster id
#
# Subcommands:
#   wire                       Probe true gRPC tunnel throughput across
#                              sizes — single shot per size, prints
#                              effective MB/s. Useful to see if you're
#                              actually on the cross-WAN slow path or
#                              healthy in-region.
#   pods [conc] [dur]          Sustained load on /workloads/pods.
#                              Defaults: 100 conn × 60s. Hits worker
#                              K8s API path; representative for the
#                              real /clusters UI.
#   bench [bytes] [conc] [dur] Sustained load on /debug/tunnel-bench.
#                              Defaults: 65536 bytes × 100 conn × 60s.
#                              Isolates gRPC tunnel performance (no
#                              K8s API in the path).
#   overload                   Step from 1 → 500 conn × 30s each, on
#                              /workloads/pods. Looks for the knee
#                              where RPS stops growing.
#   compare                    Quick side-by-side of pods + bench at
#                              the same 100 conn × 60s, for ratio
#                              checks (K8s API overhead vs pure
#                              tunnel).

set -euo pipefail

# --- args & env ---------------------------------------------------------------

# resolve_bombardier locates the bombardier binary, installing it via
# `go install` when missing. Looks in $PATH first, then the default
# `go env GOBIN` and $GOPATH/bin locations so a fresh `go install`
# is picked up even if the user hasn't added GOBIN to PATH yet.
resolve_bombardier() {
  if [[ -n "${BOMBARDIER:-}" ]] && command -v "$BOMBARDIER" >/dev/null 2>&1; then
    echo "$BOMBARDIER"; return 0
  fi
  if command -v bombardier >/dev/null 2>&1; then
    command -v bombardier; return 0
  fi
  # Probe go's install destinations even before installing — covers
  # the "installed earlier, not on PATH" case.
  if command -v go >/dev/null 2>&1; then
    local gobin
    gobin="$(go env GOBIN 2>/dev/null)"
    [[ -z "$gobin" ]] && gobin="$(go env GOPATH 2>/dev/null)/bin"
    for ext in "" ".exe"; do
      if [[ -x "$gobin/bombardier$ext" ]]; then
        echo "$gobin/bombardier$ext"; return 0
      fi
    done
  fi
  return 1
}

install_bombardier() {
  if ! command -v go >/dev/null 2>&1; then
    cat >&2 <<'MSG'
bombardier not found and `go` is unavailable for auto-install.

Install Go first (https://go.dev/dl/) or install bombardier via
your package manager:
  macOS:   brew install bombardier
  Linux:   download from https://github.com/codesenberg/bombardier/releases
  Windows: scoop install bombardier  (or download the .exe release)

Then re-run this script.
MSG
    return 1
  fi
  echo "[loadtest] bombardier not found — installing via 'go install'…" >&2
  # Default proxy.golang.org is blocked from many regions (notably CN).
  # GOPROXY env is sticky from caller if set; otherwise fall back to
  # goproxy.cn,direct which works globally.
  GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" \
    go install github.com/codesenberg/bombardier@latest >&2
  resolve_bombardier
}

BOMB="$(resolve_bombardier || true)"
if [[ -z "$BOMB" ]]; then
  BOMB="$(install_bombardier)" || exit 1
fi

cmd="${1:-}"
shift || true

# help / -h / empty arg short-circuits BEFORE env validation — the
# whole point of help is to tell you what env vars to set.
if [[ -z "$cmd" || "$cmd" == "help" || "$cmd" == "-h" || "$cmd" == "--help" ]]; then
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//' | head -n -1
  exit 0
fi

if [[ -f .env ]]; then
  # Honour repo-level .env so operators don't paste creds on the CLI.
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

: "${KPILOT_JWT:?KPILOT_JWT not set (export it or put it in .env)}"
: "${KPILOT_HOST:?KPILOT_HOST not set (e.g. http://localhost:8080)}"
: "${KPILOT_CID:?KPILOT_CID not set (cluster id)}"

CID="$KPILOT_CID"
HOST="$KPILOT_HOST"
COOKIE_HDR="Cookie: kpilot_token=$KPILOT_JWT"
ENC_HDR="Accept-Encoding: identity"

# Defaults consistent across subcommands.
DEFAULT_CONC="${LOADTEST_CONC:-100}"
DEFAULT_DUR="${LOADTEST_DUR:-60s}"

# --- helpers ------------------------------------------------------------------

run_bomb() {
  local label="$1"; shift
  echo "=== $label ==="
  "$BOMB" --header "$COOKIE_HDR" --header "$ENC_HDR" -k -l "$@"
  echo
}

# --- subcommands --------------------------------------------------------------

wire_probe() {
  # One-shot per size. Bombardier with -n 1 prints latency cleanly and
  # avoids amortising over many requests — what we want when probing
  # raw wire speed.
  echo "=== Wire throughput probe (one-shot per size) ==="
  for B in 4096 102400 1048576 10485760 52428800; do
    echo "-- bytes=$B --"
    "$BOMB" --header "$COOKIE_HDR" --header "$ENC_HDR" -k -n 1 \
      "$HOST/api/v1/clusters/$CID/debug/tunnel-bench?bytes=$B"
    echo
  done
}

case "$cmd" in
  wire)
    wire_probe
    ;;

  pods)
    conc="${1:-$DEFAULT_CONC}"
    dur="${2:-$DEFAULT_DUR}"
    run_bomb "pods (limit=100), conn=$conc, dur=$dur" \
      -c "$conc" -d "$dur" \
      "$HOST/api/v1/clusters/$CID/workloads/pods?limit=100"
    ;;

  bench)
    bytes="${1:-65536}"
    conc="${2:-$DEFAULT_CONC}"
    dur="${3:-$DEFAULT_DUR}"
    run_bomb "tunnel-bench bytes=$bytes, conn=$conc, dur=$dur" \
      -c "$conc" -d "$dur" \
      "$HOST/api/v1/clusters/$CID/debug/tunnel-bench?bytes=$bytes"
    ;;

  overload)
    # 30 s per step is long enough to escape jitter but short enough
    # to keep the full sweep under 5 min. p95 is the headline metric
    # here — when p95 stops dropping with more conn, you've found
    # the saturation point.
    for c in 1 5 20 50 100 200 500; do
      run_bomb "pods conn=$c dur=30s" -c "$c" -d 30s \
        "$HOST/api/v1/clusters/$CID/workloads/pods?limit=100"
    done
    ;;

  compare)
    run_bomb "pods (75KB, K8s API path)" \
      -c "$DEFAULT_CONC" -d "$DEFAULT_DUR" \
      "$HOST/api/v1/clusters/$CID/workloads/pods?limit=100"
    run_bomb "tunnel-bench 64KB (pure gRPC tunnel)" \
      -c "$DEFAULT_CONC" -d "$DEFAULT_DUR" \
      "$HOST/api/v1/clusters/$CID/debug/tunnel-bench?bytes=65536"
    ;;

  *)
    echo "unknown subcommand: $cmd (run '$0 help')" >&2
    exit 2
    ;;
esac
