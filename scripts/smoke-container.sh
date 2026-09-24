#!/usr/bin/env bash
# Exercise a locally built server image without using deployment configuration.
set -euo pipefail

image=${1:?usage: smoke-container.sh IMAGE}
container_id=''

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

setup_token="$(openssl rand -hex 32)"
container_id="$(docker run -d --rm -p 127.0.0.1::8787 \
  --env OBSIDIAN_GIT_SYNC_PASSWORD_USER=smoke-test \
  --env OBSIDIAN_GIT_SYNC_PASSWORD_SETUP_TOKEN="$setup_token" \
  --env OBSIDIAN_GIT_SYNC_ALLOWED_REMOTE_HOSTS= \
  "$image")"

port="$(docker port "$container_id" 8787/tcp | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')"
[[ -n "$port" ]] || { echo 'container did not publish port 8787' >&2; exit 1; }

for _ in {1..30}; do
  if curl --fail --silent --show-error "http://127.0.0.1:$port/v1/server/info" >/dev/null; then
    exit 0
  fi
  sleep 1
done

echo 'server info endpoint did not become ready' >&2
exit 1
