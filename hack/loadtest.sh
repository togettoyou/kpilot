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
#   monitoring [conc] [dur]    Real Monitoring-page simulation — fans
#                              out cluster-metrics + node-metrics +
#                              pod-metrics + pod-health in parallel.
#                              The heaviest realistic load: each "user"
#                              triggers 26+ PromQL queries to VM via
#                              the worker tunnel.
#   overload                   Step from 1 → 500 conn × 30s each, on
#                              /workloads/pods. Stops early if error
#                              rate exceeds 5% (likely server saturation
#                              on small-instance deployments).
#   compare                    Quick side-by-side of pods + bench at
#                              the same 100 conn × 60s, for ratio
#                              checks (K8s API overhead vs pure
#                              tunnel).
#   hol [storm] [dur]          Head-of-line block validation. Runs N
#                              concurrent `/logs/search?limit=10000`
#                              storms (19 MB each) and probes
#                              `/workloads/pods` latency during the
#                              storm. Validates the per-request_id
#                              round-robin fair scheduler in
#                              `pkg/{server/gateway,worker/tunnel}/sender.go`.
#                              Defaults: 10 storm slots × 30s.
#                              Sweep recommendations: 10 / 50 / 100 / 200.
#
# Any subcommand respects LOADTEST_SAMPLE=1 to start a background
# poller of /api/v1/metrics every 2s; the high-water mark for
# goroutines / pending channels prints after the test finishes. Useful
# for spotting goroutine leaks or pending-channel buildup that the
# raw bombardier output doesn't show.

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

# start_metrics_sampler polls /api/v1/metrics every 2 s in the background
# and tracks the high-water marks for goroutines / pending channels /
# stream count. Use stop_metrics_sampler to print the summary. Enable
# with LOADTEST_SAMPLE=1.
SAMPLER_PID=""
SAMPLER_OUT=""
start_metrics_sampler() {
  [[ "${LOADTEST_SAMPLE:-0}" != "1" ]] && return 0
  SAMPLER_OUT="$(mktemp)"
  (
    while :; do
      curl -s --max-time 3 -H "$COOKIE_HDR" "$HOST/api/v1/metrics" 2>/dev/null \
        | tr ',' '\n' >> "$SAMPLER_OUT" || true
      echo "---" >> "$SAMPLER_OUT"
      sleep 2
    done
  ) &
  SAMPLER_PID=$!
}
stop_metrics_sampler() {
  [[ -z "$SAMPLER_PID" ]] && return 0
  kill "$SAMPLER_PID" 2>/dev/null || true
  wait "$SAMPLER_PID" 2>/dev/null || true
  echo "=== metrics high-water marks (LOADTEST_SAMPLE=1) ==="
  # Pull each numeric field and pick the max. jq would be cleaner but
  # we don't want a hard dependency.
  for key in goroutines pending pendingHTTP streams pluginLogSessions vmResponse; do
    local mx
    mx=$(grep -oE "\"$key\":[0-9]+" "$SAMPLER_OUT" 2>/dev/null \
         | awk -F: '{print $2}' | sort -n | tail -1)
    printf "  %-22s max=%s\n" "$key" "${mx:-?}"
  done
  rm -f "$SAMPLER_OUT"
  SAMPLER_PID=""; SAMPLER_OUT=""
  echo
}
trap stop_metrics_sampler EXIT

# pct reads one numeric column from stdin and prints avg / p50 / p90 /
# p95 / p99 / max / n. Used by `hol` to summarise probe samples.
pct() {
  sort -n | awk 'BEGIN{c=0; s=0} {s+=$1; arr[c++]=$1} END{
    if (c == 0) { print "  no samples"; exit }
    printf "  avg=%.3fs p50=%.3fs p90=%.3fs p95=%.3fs p99=%.3fs max=%.3fs n=%d\n",
      s/c, arr[int(c*0.5)], arr[int(c*0.9)], arr[int(c*0.95)], arr[int(c*0.99)], arr[c-1], c
  }'
}

# fan_out runs N curl commands in parallel, prints completion time +
# error count. Used by `monitoring` to simulate the Monitoring page's
# real shape (concurrent endpoints, not a single one repeated).
fan_out() {
  local label="$1"; shift
  local urls=("$@")
  local start; start=$(date +%s.%N)
  local pids=() err=0
  for u in "${urls[@]}"; do
    (curl -fsS --max-time 60 -H "$COOKIE_HDR" -H "$ENC_HDR" "$u" >/dev/null) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || err=$((err+1)); done
  local end; end=$(date +%s.%N)
  printf "  %-30s wall=%.2fs errors=%d/%d\n" "$label" \
    "$(echo "$end - $start" | bc -l)" "$err" "${#urls[@]}"
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
    start_metrics_sampler
    run_bomb "pods (limit=100), conn=$conc, dur=$dur" \
      -c "$conc" -d "$dur" \
      "$HOST/api/v1/clusters/$CID/workloads/pods?limit=100"
    stop_metrics_sampler
    ;;

  bench)
    bytes="${1:-65536}"
    conc="${2:-$DEFAULT_CONC}"
    dur="${3:-$DEFAULT_DUR}"
    start_metrics_sampler
    run_bomb "tunnel-bench bytes=$bytes, conn=$conc, dur=$dur" \
      -c "$conc" -d "$dur" \
      "$HOST/api/v1/clusters/$CID/debug/tunnel-bench?bytes=$bytes"
    stop_metrics_sampler
    ;;

  monitoring)
    # Real Monitoring page = parallel fetches of 4 endpoints. Repeat
    # the full fan-out `dur / 5s` times to approximate `dur`-worth of
    # polling at the browser's default 5s interval. Conc here = number
    # of simulated open tabs.
    conc="${1:-5}"
    dur="${2:-30s}"
    secs=${dur%s}
    iters=$(( secs / 5 ))
    [[ $iters -lt 1 ]] && iters=1
    echo "=== monitoring sim: tabs=$conc iters=$iters (≈${dur}) ==="
    start_metrics_sampler
    for ((i=1; i<=iters; i++)); do
      urls=()
      for ((u=0; u<conc; u++)); do
        urls+=(
          "$HOST/api/v1/clusters/$CID/cluster-metrics?range=1h"
          "$HOST/api/v1/clusters/$CID/node-metrics?range=1h"
          "$HOST/api/v1/clusters/$CID/pod-metrics?range=1h&limit=20"
          "$HOST/api/v1/clusters/$CID/pod-health?limit=10"
        )
      done
      fan_out "iter $i ($((conc * 4)) reqs)" "${urls[@]}"
    done
    stop_metrics_sampler
    ;;

  overload)
    # Step until error rate > 5%, then stop — small-instance deploys
    # (1c/512m) saturate well before 500 conn, and continuing past
    # saturation just burns time on timeouts.
    start_metrics_sampler
    for c in 1 5 20 50 100 200 500; do
      label="pods conn=$c dur=30s"
      echo "=== $label ==="
      # Tee bombardier output so we can scrape error counts.
      out=$(mktemp)
      "$BOMB" --header "$COOKIE_HDR" --header "$ENC_HDR" -k -l \
        -c "$c" -d 30s \
        "$HOST/api/v1/clusters/$CID/workloads/pods?limit=100" | tee "$out"
      echo
      # bombardier prints `5xx - N` and `others - N`; sum + compute %.
      twoxx=$(grep -oE "2xx - [0-9]+" "$out" | awk '{print $3}')
      fivexx=$(grep -oE "5xx - [0-9]+" "$out" | awk '{print $3}')
      others=$(grep -oE "others - [0-9]+" "$out" | awk '{print $3}')
      rm -f "$out"
      err=$(( ${fivexx:-0} + ${others:-0} ))
      total=$(( ${twoxx:-0} + err ))
      if [[ $total -gt 0 ]] && [[ $(( err * 100 / total )) -gt 5 ]]; then
        echo ">>> error rate $((err * 100 / total))% > 5%, stopping sweep <<<"
        break
      fi
    done
    stop_metrics_sampler
    ;;

  compare)
    start_metrics_sampler
    run_bomb "pods (75KB, K8s API path)" \
      -c "$DEFAULT_CONC" -d "$DEFAULT_DUR" \
      "$HOST/api/v1/clusters/$CID/workloads/pods?limit=100"
    run_bomb "tunnel-bench 64KB (pure gRPC tunnel)" \
      -c "$DEFAULT_CONC" -d "$DEFAULT_DUR" \
      "$HOST/api/v1/clusters/$CID/debug/tunnel-bench?bytes=65536"
    stop_metrics_sampler
    ;;

  hol)
    # Head-of-line block validation. Drives N concurrent large log
    # queries (19 MB each, the heaviest realistic request shape) and
    # measures probe latency on a small endpoint during the storm.
    # If the per-request_id round-robin scheduler is doing its job,
    # probe p50 should stay well under 1s even at 100× storm; if it's
    # broken (single FIFO slow lane), probe latency goes to seconds.
    #
    # Reads three numbers, idle / under-load / recovery, so a regression
    # in fair-scheduling jumps out at the under-load line. We sweep
    # 10 / 50 / 100 / 200 when validating tunnel changes; ceiling on
    # 2c/2G deploys is ~200× before p50 enters the 300ms band.
    storm="${1:-10}"
    dur="${2:-30s}"
    secs="${dur%s}"
    if ! [[ "$secs" =~ ^[0-9]+$ ]]; then
      echo "hol: dur must be in <N>s form (got '$dur')" >&2; exit 2
    fi

    from=$(date -u -d "1 hour ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
           || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)
    to=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    storm_url="$HOST/api/v1/clusters/$CID/logs/search?query=*&from=$from&to=$to&limit=10000"
    probe_url="$HOST/api/v1/clusters/$CID/workloads/pods?limit=100"

    start_metrics_sampler
    echo "=== hol: storm=${storm}× logs(limit=10000) probe=pods dur=${dur} ==="

    echo "-- idle baseline (10 samples) --"
    for _ in $(seq 1 10); do
      curl -s -o /dev/null -w "%{time_total}\n" -H "$COOKIE_HDR" "$probe_url"
    done | pct

    echo
    echo "-- launching ${storm}× storm in background --"
    storm_log=$(mktemp)
    storm_end=$(( $(date +%s) + secs ))
    for slot in $(seq 1 "$storm"); do
      (ok=0; fail=0
       while [[ $(date +%s) -lt $storm_end ]]; do
         code=$(curl -s -m 120 -o /dev/null -w "%{http_code}" \
                -H "$COOKIE_HDR" "$storm_url" 2>/dev/null)
         if [[ "$code" == "200" ]]; then ok=$((ok+1)); else fail=$((fail+1)); fi
       done
       echo "slot$slot ok=$ok fail=$fail" >> "$storm_log") &
    done

    # Let the storm ramp before we measure — first request per slot
    # has cold-cache cost we don't want polluting the probe samples.
    sleep 3

    echo "-- probe latency DURING storm (40 samples @0.5s) --"
    probe_log=$(mktemp)
    for _ in $(seq 1 40); do
      curl -s -m 30 -o /dev/null -w "%{time_total} %{http_code}\n" \
        -H "$COOKIE_HDR" "$probe_url" >> "$probe_log"
      sleep 0.5
    done
    awk '{print $1}' "$probe_log" | pct
    echo "  http codes:"
    awk '{print $2}' "$probe_log" | sort | uniq -c | sed 's/^/    /'
    rm -f "$probe_log"

    # Block until every storm slot has appended its line — `wait` with
    # no args waits for all backgrounded children.
    wait
    echo
    echo "-- storm completion --"
    awk -F'[= ]' '{ok+=$3; fail+=$5} END{
      printf "  slots=%d total_ok=%d total_fail=%d avg_per_slot=%.1f\n",
        NR, ok, fail, (NR>0 ? ok/NR : 0)
    }' "$storm_log"
    rm -f "$storm_log"

    echo
    echo "-- recovery (10 samples, 3s after storm) --"
    sleep 3
    for _ in $(seq 1 10); do
      curl -s -o /dev/null -w "%{time_total}\n" -H "$COOKIE_HDR" "$probe_url"
    done | pct

    stop_metrics_sampler
    ;;

  *)
    echo "unknown subcommand: $cmd (run '$0 help')" >&2
    exit 2
    ;;
esac
