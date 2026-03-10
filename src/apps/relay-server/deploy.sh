#!/usr/bin/env bash
# BitFun Relay Server — one-click deploy script.
# Usage:  bash deploy.sh [--skip-build] [--skip-health-check]
#
# Run this script on the target server itself after SSH login.
# It deploys to the current machine only; it does not SSH to a remote host.
#
# Prerequisites: Docker, Docker Compose

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_BUILD=false
SKIP_HEALTH_CHECK=false

usage() {
  cat <<'EOF'
BitFun Relay Server deploy script

Usage:
  bash deploy.sh [options]

Run location:
  Execute this script on the target server itself after SSH login.
  This script only deploys to the current machine.

Options:
  --skip-build         Skip docker compose build, only restart services
  --skip-health-check  Skip post-deploy health check
  -h, --help           Show this help message
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

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-health-check) SKIP_HEALTH_CHECK=true ;;
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

echo "=== BitFun Relay Server Deploy ==="
echo "Target: current machine"
echo "Note: run this script on the target server after SSH login."
check_command docker
check_docker_compose

cd "$SCRIPT_DIR"

# Stop old containers if running
echo "[1/3] Stopping old containers (if running)..."
docker compose down 2>/dev/null || true
echo "  Done."

# Build
if [ "$SKIP_BUILD" = true ]; then
  echo "[2/3] Skipping Docker build (--skip-build)"
else
  echo "[2/3] Building Docker images..."
  docker compose build
fi

# Start
echo "[3/3] Starting services..."
docker compose up -d

if [ "$SKIP_HEALTH_CHECK" = false ]; then
  echo "Waiting for services to start..."
  sleep 5
  echo "Checking relay health endpoint..."
  if command -v curl >/dev/null 2>&1; then
    MAX_RETRIES=6
    RETRY=0
    while [ $RETRY -lt $MAX_RETRIES ]; do
      if curl -fsS --max-time 5 "http://127.0.0.1:9700/health" >/dev/null 2>&1; then
        echo "Health check passed: http://127.0.0.1:9700/health"
        break
      fi
      RETRY=$((RETRY + 1))
      if [ $RETRY -lt $MAX_RETRIES ]; then
        echo "  Retry $RETRY/$MAX_RETRIES in 3s..."
        sleep 3
      else
        echo "Warning: health check failed after $MAX_RETRIES attempts. Check logs:"
        docker compose logs --tail=30 relay-server
      fi
    done
  else
    echo "Warning: 'curl' not found, skipped health check."
  fi
fi

echo ""
echo "=== Deploy complete ==="
echo "Relay server running on port 9700"
echo "Caddy proxy on ports 80/443"
echo ""
echo "Custom Server URL examples for BitFun Desktop:"
echo "  - Direct relay:        http://<YOUR_SERVER_IP>:9700"
echo ""
echo "Check status:  docker compose ps"
echo "Start:         bash start.sh"
echo "Restart:       bash restart.sh"
echo "Stop:          bash stop.sh"
echo "View logs:     docker compose logs -f relay-server"
