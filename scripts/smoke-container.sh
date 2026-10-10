#!/usr/bin/env bash
# Exercise a locally built server image without using deployment configuration.
set -euo pipefail

image=${1:?usage: smoke-container.sh IMAGE}
container_id=''
volume_id=''

cleanup() {
  status=$?
  if [[ -n "$container_id" ]]; then
    if (( status != 0 )); then
      docker inspect --format '{{json .State}}' "$container_id" >&2 || true
      docker logs --tail 50 "$container_id" >&2 || true
    fi
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$volume_id" ]]; then
    docker volume rm "$volume_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Initialize disposable publication state using the packaged offline CLI. No account
# is needed for the public server-info endpoint; password mode permits empty accounts.
volume_id="$(docker volume create)"
docker run --rm --network none -v "$volume_id:/data" \
  "$image" admin --data-dir /data publication initialize

# Retain an exited container until cleanup so startup failures have useful logs.
container_id="$(docker run -d -p 127.0.0.1::8787 \
  -v "$volume_id:/data" \
  --env OBSIDIAN_GIT_SYNC_AUTH_MODE=password \
  --env OBSIDIAN_GIT_SYNC_ALLOWED_REMOTE_HOSTS= \
  "$image")"

port="$(docker port "$container_id" 8787/tcp | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')" || port=''
[[ -n "$port" ]] || { echo 'container did not publish port 8787' >&2; exit 1; }

for _ in {1..30}; do
  if curl --fail --silent --show-error "http://127.0.0.1:$port/v1/server/info" >/dev/null; then
    exit 0
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" != true ]]; then
    echo 'container exited before server info became ready' >&2
    exit 1
  fi
  sleep 1
done

echo 'server info endpoint did not become ready' >&2
exit 1
