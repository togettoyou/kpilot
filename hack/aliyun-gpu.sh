#!/usr/bin/env bash
# aliyun-gpu — bring up / tear down a spot Aliyun GPU box for kpilot worker testing.
#
#   aliyun-gpu up <ip>        install k3s, pull kubeconfig, start SSH tunnel, merge context
#   aliyun-gpu down           kill the tunnel + remove local context (server untouched)
#   aliyun-gpu reset          down + delete kubeconfig file and backups
#   aliyun-gpu status         show tunnel pid + cluster reachability
#
# Password: set $ALIYUN_GPU_PASSWORD (or you'll be prompted). Once the pubkey is
# pushed, subsequent runs against the same IP don't need it.

set -euo pipefail

CONTEXT="aliyun-gpu"
KUBE_FILE="$HOME/.kube/aliyun-gpu.yaml"
LOCAL_PORT=6443
SSH_USER="root"
SSH_KEY="$HOME/.ssh/id_ed25519"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\033[1;36m▸\033[0m %s\n' "$*"; }

usage() {
  sed -n '/^#!/d;/^# aliyun-gpu/,/^[^#]/p' "$0" | sed '/^[^#]/d;s/^# \{0,1\}//'
  exit "${1:-1}"
}

tunnel_pid() {
  lsof -tiTCP:$LOCAL_PORT -sTCP:LISTEN 2>/dev/null | head -1
}

kill_tunnel() {
  local pid
  pid=$(tunnel_pid)
  if [[ -n "${pid:-}" ]]; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    yellow "killed tunnel pid=$pid"
  fi
}

push_key() {
  local ip=$1
  # First try keyless — if it already works, skip the password dance.
  if ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
       "$SSH_USER@$ip" 'true' 2>/dev/null; then
    return 0
  fi
  : "${ALIYUN_GPU_PASSWORD:=}"
  if [[ -z "$ALIYUN_GPU_PASSWORD" ]]; then
    read -rsp "password for $SSH_USER@$ip: " ALIYUN_GPU_PASSWORD
    echo
  fi
  step "pushing pubkey via expect"
  expect <<EOF
set timeout 30
log_user 0
spawn ssh-copy-id -o StrictHostKeyChecking=no -i ${SSH_KEY}.pub $SSH_USER@$ip
expect {
  -re "password:|Password:" { send "$ALIYUN_GPU_PASSWORD\r"; exp_continue }
  "Permission denied" { exit 1 }
  eof
}
EOF
}

remote_ssh() {
  local ip=$1
  shift
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$SSH_USER@$ip" "$@"
}

cmd_up() {
  local ip=${1:-}
  [[ -z "$ip" ]] && { red "missing <ip>"; usage; }

  step "verifying SSH access to $ip"
  push_key "$ip"
  remote_ssh "$ip" 'true' || { red "SSH still failing"; exit 1; }

  step "checking remote: OS, GPU, NVIDIA runtime"
  remote_ssh "$ip" 'set -e
    . /etc/os-release; echo "OS=$PRETTY_NAME"
    nvidia-smi -L | head -1
    command -v nvidia-container-runtime >/dev/null \
      || { echo "ERROR: nvidia-container-runtime not on PATH"; exit 1; }
    echo "runtime=$(nvidia-ctk --version | head -1)"
  '

  step "installing k3s (skip if already present)"
  # default-runtime=nvidia is required: without it, k3s containerd
  # uses runc as default and the volcano-vgpu-device-plugin pod can't
  # see /usr/lib/x86_64-linux-gnu/libnvidia-ml.so → NVML
  # ERROR_LIBRARY_NOT_FOUND. The vGPU plugin doesn't set
  # runtimeClassName on itself, so flipping the cluster-wide default
  # is the only fix.
  remote_ssh "$ip" '
    mkdir -p /etc/rancher/k3s
    cat > /etc/rancher/k3s/config.yaml <<EOF
default-runtime: nvidia
EOF
    if systemctl is-active --quiet k3s; then
      echo "k3s already active: $(k3s --version | head -1)"
      # Re-apply the config in case this is an upgrade path where the
      # box had k3s but no default-runtime set.
      if ! grep -q "default_runtime_name = \"nvidia\"" \
        /var/lib/rancher/k3s/agent/etc/containerd/config.toml 2>/dev/null; then
        systemctl restart k3s
      fi
    else
      curl -sfL https://get.k3s.io | \
        INSTALL_K3S_EXEC="--write-kubeconfig-mode 644 --disable traefik --tls-san '"$ip"'" \
        sh -
    fi
    kubectl wait --for=condition=Ready node --all --timeout=60s >/dev/null
  '

  step "ensuring nvidia RuntimeClass exists"
  remote_ssh "$ip" '
    kubectl get runtimeclass nvidia >/dev/null 2>&1 || \
    kubectl create -f - <<EOF
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: nvidia
handler: nvidia
EOF
  '

  step "pulling kubeconfig to $KUBE_FILE"
  scp -q -o StrictHostKeyChecking=no "$SSH_USER@$ip:/etc/rancher/k3s/k3s.yaml" "$KUBE_FILE"
  chmod 600 "$KUBE_FILE"
  # Point at localhost so it works through the tunnel below.
  sed -i '' "s#https://127.0.0.1:6443#https://127.0.0.1:$LOCAL_PORT#" "$KUBE_FILE"

  step "starting SSH tunnel localhost:$LOCAL_PORT → $ip:6443"
  kill_tunnel
  ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
      -L "$LOCAL_PORT:127.0.0.1:6443" -N -f "$SSH_USER@$ip"
  sleep 2
  local pid
  pid=$(tunnel_pid) || true
  [[ -z "$pid" ]] && { red "tunnel didn't come up"; exit 1; }
  green "tunnel pid=$pid"

  step "merging into ~/.kube/config as context '$CONTEXT'"
  local merged
  merged=$(mktemp)
  cp "$HOME/.kube/config" "$HOME/.kube/config.bak.$(date +%s)"
  # Drop any old aliyun-gpu entries first so a re-up doesn't accumulate stale clusters.
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
  green "  teardown: aliyun-gpu down"
}

cmd_down() {
  step "killing tunnel + removing local context"
  kill_tunnel
  kubectl config delete-context "$CONTEXT" 2>/dev/null || true
  kubectl config delete-cluster default 2>/dev/null || true
  kubectl config delete-user default 2>/dev/null || true
  # If the just-deleted context was current, fall back to the first remaining one.
  if ! kubectl config current-context >/dev/null 2>&1; then
    local first
    first=$(kubectl config get-contexts -o name | head -1 || true)
    [[ -n "$first" ]] && kubectl config use-context "$first" >/dev/null
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
  if [[ -n "$pid" ]]; then
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
