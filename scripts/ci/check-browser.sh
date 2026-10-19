#!/usr/bin/env bash
# Only closed API/Lean fixtures belong here; never use a production server.
set -euo pipefail
cd "$(dirname "$0")/../.."
export STUDIO_TEST_URL=http://127.0.0.1:18090
mkdir -p .runtime/ci
python3 -m http.server 18090 --bind 127.0.0.1 --directory client/dist \
  > .runtime/ci/browser-server.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
for attempt in {1..30}; do
  kill -0 "$server_pid"
  if curl --fail --silent "$STUDIO_TEST_URL/" > /dev/null; then break; fi
  sleep 1
done
curl --fail --silent "$STUDIO_TEST_URL/" > /dev/null
status=0
for suite in auth-recovery provider-settings model-options chat-naming chat streaming ask-search markdown-security; do
  if ! timeout 300 node "scripts/check-${suite}-ui.mjs"; then status=1; fi
done
exit "$status"
