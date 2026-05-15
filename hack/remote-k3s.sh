#!/usr/bin/env bash
# remote-k3s — bring up / tear down a remote k3s box and merge its kubeconfig
# locally so the KPilot Worker can run against it for debugging.
#
# Works against any ssh-reachable host (bare metal, cloud VM, on-prem box).
# Custom ssh port supported via positional arg.
#
#   remote-k3s up <host> [port]   install k3s, pull kubeconfig, start SSH tunnel, merge context
#   remote-k3s down               kill the tunnel + remove local context (server untouched)
#   remote-k3s reset              down + delete kubeconfig file and backups
#   remote-k3s status             show tunnel pid + cluster reachability
#
# GPU is auto-detected: if `nvidia-smi` is on the remote PATH we set
# default-runtime=nvidia + apply the nvidia RuntimeClass; otherwise we
# install a vanilla CPU-only k3s. Either path produces a usable cluster
# for general Worker debugging — vGPU-specific testing just needs the
# GPU path to take.
#
# Password: set $REMOTE_K3S_PASSWORD (or you'll be prompted). Once the
# pubkey is pushed, subsequent runs against the same host don't need it.
#
# Platforms: macOS / Linux / Git Bash / WSL. Avoids macOS-only `sed -i ''`
# and the `lsof` port-scan trick (the tunnel's pid is tracked via a file
# written by us, so no platform-specific tool to discover the listener).

set -euo pipefail

CONTEXT="remote-k3s"
KUBE_FILE="$HOME/.kube/remote-k3s.yaml"
PID_FILE="$HOME/.kube/remote-k3s.tunnel.pid"
LOCAL_PORT=6443
SSH_USER="root"
SSH_KEY="$HOME/.ssh/id_ed25519"

# SSH_PORT is what every ssh/scp call (and ssh-copy-id) injects via -p / -P /
# -o Port=. Default 22; cmd_up overrides from positional arg #2.
SSH_PORT=22

# SSH connection multiplexing: every ssh/scp call below reuses a single
# master connection instead of opening a fresh TCP+handshake each time.
# cmd_up makes ~10 separate ssh hops (probe, OS check, GPU detect,
# toolkit install, k3s install, RuntimeClass apply, kubeconfig scp, …);
# without multiplex they each count against sshd's MaxStartups
# (default 10:30:100) and a previous run that left even a few probes
# in flight can saturate the throttle window so new connections TCP
# fine but never finish the SSH handshake — `ConnectTimeout` doesn't
# catch that (it only covers the TCP layer). ServerAlive* gives every
# individual call a real liveness check on top.
SSH_MUX_DIR="$HOME/.ssh/control"
mkdir -p "$SSH_MUX_DIR" && chmod 700 "$SSH_MUX_DIR"
SSH_OPTS=(
  -o StrictHostKeyChecking=no
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
  -o ControlMaster=auto
  -o "ControlPath=$SSH_MUX_DIR/%C"
  -o ControlPersist=60s
)

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\033[1;36m▸\033[0m %s\n' "$*"; }

usage() {
  sed -n '/^#!/d;/^# remote-k3s/,/^[^#]/p' "$0" | sed '/^[^#]/d;s/^# \{0,1\}//'
  exit "${1:-1}"
}

# tunnel_pid prints the currently-tracked pid if the process is alive. Empty
# stdout otherwise. Uses a pid file we wrote at start_tunnel time instead of
# scanning for the listening port (lsof / ss / netstat all vary across mac /
# linux / git-bash / wsl).
tunnel_pid() {
  [[ -f "$PID_FILE" ]] || return 0
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null) || return 0
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  fi
}

kill_tunnel() {
  local pid
  pid=$(tunnel_pid)
  if [[ -n "${pid:-}" ]]; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    yellow "killed tunnel pid=$pid"
  fi
  rm -f "$PID_FILE"
}

# start_tunnel runs ssh -N -L in the background under nohup + disown so it
# survives the script exit, and writes its pid to PID_FILE for kill_tunnel.
# We deliberately don't use `ssh -f` — that daemonizes via fork, hiding the
# real pid behind a parent we can't track.
start_tunnel() {
  local host=$1
  kill_tunnel
  nohup ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
            -o StrictHostKeyChecking=no \
            -p "$SSH_PORT" \
            -L "$LOCAL_PORT:127.0.0.1:6443" \
            -N "$SSH_USER@$host" \
            >/dev/null 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  disown "$pid" 2>/dev/null || true
  # Give the master a moment to settle; if it exits in the first 2s
  # treat as "didn't come up" (auth fail, port in use, etc.).
  sleep 2
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    red "tunnel didn't come up"
    return 1
  fi
  green "tunnel pid=$pid"
}

# sed_replace_inplace performs a portable sed -i substitution. macOS BSD sed
# wants `sed -i ''`, GNU sed wants `sed -i` without arg — instead of branching
# on uname we just tmpfile + mv, which works the same on every platform.
sed_replace_inplace() {
  local pattern=$1 file=$2
  local tmp
  tmp=$(mktemp)
  sed "$pattern" "$file" > "$tmp" && mv "$tmp" "$file"
}

push_key() {
  local host=$1
  # First try keyless — if it already works, skip the password dance.
  # Bypass multiplex on the probe (-o ControlPath=none): we don't want
  # a half-formed master socket lingering when the BatchMode probe
  # fails for auth reasons.
  if ssh "${SSH_OPTS[@]}" -o ControlPath=none -o BatchMode=yes \
       -o ConnectTimeout=5 -p "$SSH_PORT" "$SSH_USER@$host" 'true' 2>/dev/null; then
    return 0
  fi
  : "${REMOTE_K3S_PASSWORD:=}"
  if [[ -z "$REMOTE_K3S_PASSWORD" ]]; then
    read -rsp "password for $SSH_USER@$host:$SSH_PORT: " REMOTE_K3S_PASSWORD
    echo
  fi
  step "pushing pubkey via expect"
  if ! command -v expect >/dev/null 2>&1; then
    red "expect not installed; install it (apt: expect / brew: expect / pacman: expect) or"
    red "push the key manually with:"
    red "  ssh-copy-id -o Port=$SSH_PORT -i ${SSH_KEY}.pub $SSH_USER@$host"
    exit 1
  fi
  # ssh-copy-id's `-p PORT` arg isn't portable across implementations; the
  # `-o Port=` form goes through to the underlying ssh and works everywhere.
  expect <<EOF
set timeout 30
log_user 0
spawn ssh-copy-id -o StrictHostKeyChecking=no -o Port=$SSH_PORT -i ${SSH_KEY}.pub $SSH_USER@$host
expect {
  -re "password:|Password:" { send "$REMOTE_K3S_PASSWORD\r"; exp_continue }
  "Permission denied" { exit 1 }
  eof
}
EOF
}

remote_ssh() {
  local host=$1
  shift
  ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 \
      -p "$SSH_PORT" "$SSH_USER@$host" "$@"
}

remote_scp_from() {
  local host=$1 src=$2 dst=$3
  scp -q "${SSH_OPTS[@]}" -P "$SSH_PORT" \
      "$SSH_USER@$host:$src" "$dst"
}

# detect_gpu returns 0 if the remote has a working nvidia-smi + the
# NVIDIA Container Toolkit; 1 otherwise. Soft-fails: a missing GPU isn't
# an error, it just steers us to a vanilla k3s install. rc=2 means
# "GPU present but toolkit missing" — install_nvidia_toolkit below
# auto-fixes it.
detect_gpu() {
  local host=$1
  remote_ssh "$host" '
    command -v nvidia-smi >/dev/null && nvidia-smi -L 2>/dev/null | grep -q . || exit 1
    command -v nvidia-container-runtime >/dev/null || exit 2
  '
}

# install_nvidia_toolkit installs the NVIDIA Container Toolkit on a
# Debian/Ubuntu remote. Idempotent — the apt install will no-op when
# already present. After install, restart k3s if it's already running
# so containerd picks up the new runtime binary; if k3s isn't installed
# yet, the regular install path below will discover the runtime on
# first start.
#
# Not supported on RHEL-family images — the existing script only ever
# claimed Ubuntu support and the remote-k3s test rig is consistently
# Ubuntu. If we add RHEL targets later this is the place to add an
# `if command -v dnf` branch.
install_nvidia_toolkit() {
  local host=$1
  step "installing NVIDIA Container Toolkit on $host"
  remote_ssh "$host" 'set -e
    if ! command -v apt-get >/dev/null; then
      echo "ERROR: apt-get not found — Debian/Ubuntu only for now" >&2
      exit 1
    fi
    DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl gnupg ca-certificates >/dev/null
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
      gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
      sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-container-toolkit
    echo "installed: $(nvidia-ctk --version | head -1)"
    # If k3s is already up (re-run case), restart so its embedded
    # containerd re-discovers the new runtime binary. First-install
    # case picks it up automatically on initial start.
    if systemctl is-active --quiet k3s; then
      systemctl restart k3s
    fi
  '
}

cmd_up() {
  local host=${1:-}
  [[ -z "$host" ]] && { red "missing <host>"; usage; }
  if [[ -n "${2:-}" ]]; then
    SSH_PORT=$2
  fi

  step "verifying SSH access to $host:$SSH_PORT"
  push_key "$host"
  remote_ssh "$host" 'true' || { red "SSH still failing"; exit 1; }

  step "checking remote: OS + GPU"
  remote_ssh "$host" 'set -e; . /etc/os-release; echo "OS=$PRETTY_NAME"'

  local has_gpu=0
  if detect_gpu "$host"; then
    has_gpu=1
    step "GPU + NVIDIA runtime detected"
    remote_ssh "$host" '
      nvidia-smi -L | head -1
      echo "runtime=$(nvidia-ctk --version 2>/dev/null | head -1)"
    ' || true
  else
    local rc=$?
    if [[ "$rc" == "2" ]]; then
      # GPU is there, just no container-toolkit yet. Most cloud
      # vendors' GPU images ship CUDA + drivers but not the
      # container-runtime side; install ourselves so vGPU testing
      # works first-shot instead of asking the user to ssh in
      # manually.
      yellow "GPU present but nvidia-container-runtime missing — installing toolkit"
      install_nvidia_toolkit "$host"
      has_gpu=1
    else
      yellow "no GPU on remote — installing CPU-only k3s"
    fi
  fi

  step "installing k3s (skip if already present)"
  # When GPU is available we set default-runtime=nvidia. Without that
  # k3s containerd uses runc and the volcano-vgpu-device-plugin pod
  # can't see /usr/lib/x86_64-linux-gnu/libnvidia-ml.so → NVML
  # ERROR_LIBRARY_NOT_FOUND. The plugin doesn't set its own
  # runtimeClassName, so flipping the cluster-wide default is the only
  # fix. CPU-only path skips that config entirely so a generic worker
  # debug setup doesn't need anything GPU-specific on the host.
  remote_ssh "$host" "
    HAS_GPU=$has_gpu
    mkdir -p /etc/rancher/k3s
    if [ \"\$HAS_GPU\" = 1 ]; then
      cat > /etc/rancher/k3s/config.yaml <<EOF
default-runtime: nvidia
EOF
    else
      rm -f /etc/rancher/k3s/config.yaml
    fi
    if systemctl is-active --quiet k3s; then
      echo \"k3s already active: \$(k3s --version | head -1)\"
      if [ \"\$HAS_GPU\" = 1 ] && ! grep -q 'default_runtime_name = \"nvidia\"' \
        /var/lib/rancher/k3s/agent/etc/containerd/config.toml 2>/dev/null; then
        systemctl restart k3s
      fi
    else
      curl -sfL https://get.k3s.io | \
        INSTALL_K3S_EXEC=\"--write-kubeconfig-mode 644 --disable traefik --tls-san $host\" \
        sh -
    fi
    kubectl wait --for=condition=Ready node --all --timeout=60s >/dev/null
  "

  if [[ "$has_gpu" == 1 ]]; then
    step "ensuring nvidia RuntimeClass exists"
    remote_ssh "$host" '
      kubectl get runtimeclass nvidia >/dev/null 2>&1 || \
      kubectl create -f - <<EOF
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: nvidia
handler: nvidia
EOF
    '
  fi

  step "pulling kubeconfig to $KUBE_FILE"
  remote_scp_from "$host" /etc/rancher/k3s/k3s.yaml "$KUBE_FILE"
  chmod 600 "$KUBE_FILE"
  # Point at localhost so it works through the tunnel below. Portable
  # in-place sed (works on macOS BSD + GNU + git-bash).
  sed_replace_inplace "s#https://127.0.0.1:6443#https://127.0.0.1:$LOCAL_PORT#" "$KUBE_FILE"

  step "starting SSH tunnel localhost:$LOCAL_PORT → $host:6443"
  start_tunnel "$host"

  step "merging into ~/.kube/config as context '$CONTEXT'"
  local merged
  merged=$(mktemp)
  cp "$HOME/.kube/config" "$HOME/.kube/config.bak.$(date +%s)"
  # Drop any old remote-k3s entries first so a re-up doesn't accumulate stale clusters.
  KUBECONFIG="$HOME/.kube/config" kubectl config delete-context "$CONTEXT" 2>/dev/null || true
  KUBECONFIG="$HOME/.kube/config" kubectl config delete-cluster default 2>/dev/null || true
  KUBECONFIG="$HOME/.kube/config" kubectl config delete-user default 2>/dev/null || true
  KUBECONFIG="$HOME/.kube/config:$KUBE_FILE" kubectl config view --flatten > "$merged"
  mv "$merged" "$HOME/.kube/config"
  kubectl config rename-context default "$CONTEXT" >/dev/null
  kubectl config use-context "$CONTEXT" >/dev/null

  step "verifying"
  kubectl get nodes -o wide

  green ""
  green "✓ ready — context '$CONTEXT' is active"
  green "  worker:   KUBECONFIG=$KUBE_FILE ./worker …"
  green "  teardown: remote-k3s down"
}

cmd_down() {
  step "killing tunnel + removing local context"
  kill_tunnel
  kubectl config delete-context "$CONTEXT" 2>/dev/null || true
  kubectl config delete-cluster default 2>/dev/null || true
  kubectl config delete-user default 2>/dev/null || true
  # `kubectl config current-context` keeps printing the previous
  # value even after delete-context wiped it — it just reads the
  # `current-context:` line from ~/.kube/config without checking
  # whether the target still exists. So we have to compare against
  # the actual contexts list to know we need to switch.
  local current
  current=$(kubectl config current-context 2>/dev/null || true)
  if [[ -z "$current" ]] || \
     ! kubectl config get-contexts -o name 2>/dev/null | grep -qx "$current"; then
    local first
    first=$(kubectl config get-contexts -o name 2>/dev/null | head -1 || true)
    if [[ -n "$first" ]]; then
      kubectl config use-context "$first" >/dev/null
      yellow "switched current context to '$first'"
    else
      kubectl config unset current-context >/dev/null
    fi
  fi
  green "done"
}

cmd_reset() {
  cmd_down
  rm -f "$KUBE_FILE" "$HOME"/.kube/config.bak.*
  green "removed $KUBE_FILE and backups"
}

cmd_status() {
  local pid current
  pid=$(tunnel_pid) || true
  if [[ -n "${pid:-}" ]]; then
    green "tunnel: pid=$pid (localhost:$LOCAL_PORT)"
  else
    yellow "tunnel: not running"
  fi
  current=$(kubectl config current-context 2>/dev/null || echo "<none>")
  echo "kubectl context: $current"
  if [[ "$current" == "$CONTEXT" ]]; then
    kubectl get nodes 2>&1 | tail -3
  fi
}

case "${1:-}" in
  up)     shift; cmd_up "$@" ;;
  down)   cmd_down ;;
  reset)  cmd_reset ;;
  status) cmd_status ;;
  -h|--help|"") usage 0 ;;
  *)      red "unknown command: $1"; usage ;;
esac
