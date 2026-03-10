#!/usr/bin/env bash
# BitFun Relay Server — stop script.
# Run this script on the target server itself after SSH login.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="bitfun-relay"

usage() {
  cat <<'EOF'
BitFun Relay Server stop script

Usage:
  bash stop.sh

Run location:
  Execute this script on the target server itself after SSH login.
EOF
}

check_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required but not installed."
    exit 1
  fi
}

check_docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    return 0
  fi
  echo "Error: Docker Compose (docker compose) is required."
  exit 1
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" = "true" ]
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

echo "=== BitFun Relay Server Stop ==="
check_command docker
check_docker_compose

cd "$SCRIPT_DIR"

if ! container_running; then
  echo "Relay service is already stopped. Nothing to do."
  exit 0
fi

docker compose stop

echo ""
echo "Relay service stopped."
echo "Check status:  docker compose ps"
echo "Start again:   bash start.sh"
