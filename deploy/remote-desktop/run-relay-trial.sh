#!/usr/bin/env bash
# Run on the trial server after loading a verified, immutable image.
# Data and signing-secret preparation remain explicit operator steps.
set -euo pipefail

trial_root="${TRIAL_ROOT:-/srv/openbitfun-rd-trial}"
trial_image="${TRIAL_RELAY_IMAGE:?Set the verified sha256 image ID}"
trial_container=openbitfun-rd-trial-relay
trial_owner_label=openbitfun.remote-desktop-trial
[[ "$trial_root" = /* && "$trial_root" != *'/../'* && "$trial_root" != *$'\n'* ]] || { echo 'Invalid trial root' >&2; exit 1; }
[[ "$trial_image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Expected an immutable image ID' >&2; exit 1; }
[[ -f "$trial_root/relay/trial.env" && ! -L "$trial_root/relay/trial.env" ]] || { echo 'Missing private trial environment file' >&2; exit 1; }
[[ -f "$trial_root/secrets/turn-rest-secret" && ! -L "$trial_root/secrets/turn-rest-secret" ]] || { echo 'Missing TURN secret file' >&2; exit 1; }
[[ "$(stat -c '%a:%u' "$trial_root/secrets/turn-rest-secret")" = 600:10001 ]] || { echo 'TURN secret must be mode 0600 and owned by UID 10001' >&2; exit 1; }
[[ -d "$trial_root/relay/data" && -d "$trial_root/relay/assets" ]] || { echo 'Prepare isolated data and assets first' >&2; exit 1; }
[[ "$(docker image inspect --format '{{.Architecture}}' "$trial_image")" = amd64 ]] || { echo 'The trial server requires an amd64 image' >&2; exit 1; }

if docker container inspect "$trial_container" >/dev/null 2>&1; then
  [[ "$(docker inspect --format '{{index .Config.Labels "openbitfun.remote-desktop-trial"}}' "$trial_container")" = true ]] || { echo 'Existing container is not owned by this trial' >&2; exit 1; }
  if [[ "$(docker inspect --format '{{.Image}}' "$trial_container")" = "$trial_image" ]]; then
    docker start "$trial_container" >/dev/null
    echo 'Existing trial image retained; check health and capabilities.'
    exit 0
  fi
  echo 'A different trial image is already installed. Stop/remove that exact trial container before changing images; retain its data and image for rollback.' >&2
  exit 1
fi

if ss -lnt | awk '{print $4}' | grep -Eq '(^|:)19703$'; then
  echo 'Port 19703 is already occupied' >&2
  exit 1
fi

docker run -d --name "$trial_container" --label "$trial_owner_label=true" \
  --network host --user 10001:10001 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --restart no \
  --cpus 1 --memory 768m --pids-limit 128 --ulimit nofile=8192:8192 \
  --tmpfs /tmp:size=640m,mode=1777 \
  --log-driver json-file --log-opt max-size=5m --log-opt max-file=2 \
  --env-file "$trial_root/relay/trial.env" \
  --env RELAY_PORT=19703 --env RELAY_LISTEN_ADDR=127.0.0.1:19703 \
  --env RELAY_DB_PATH=/app/data/relay.db --env RELAY_ASSET_DIR=/app/assets \
  --env RELAY_REMOTE_DESKTOP_TURN_SECRET_FILE=/run/secrets/turn-rest-secret \
  --mount "type=bind,src=$trial_root/relay/data,dst=/app/data" \
  --mount "type=bind,src=$trial_root/relay/assets,dst=/app/assets" \
  --mount "type=bind,src=$trial_root/relay/assets,dst=/app/room-web" \
  --mount "type=bind,src=$trial_root/secrets/turn-rest-secret,dst=/run/secrets/turn-rest-secret,readonly" \
  --health-cmd 'curl -fsS http://127.0.0.1:19703/health || exit 1' \
  --health-interval 15s --health-timeout 5s --health-start-period 20s --health-retries 3 \
  "$trial_image" /app/openbitfun-relay-server >/dev/null

echo 'Trial Relay started on loopback 19703. Verify /health, route/TURN capabilities and rejection of unauthenticated issuance before connecting clients.'
