#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
iid_file=$(mktemp)

cleanup() {
  if [[ -s "$iid_file" ]]; then
    docker image rm --force "$(cat "$iid_file")" >/dev/null 2>&1 || true
  fi
  rm -f "$iid_file"
}
trap cleanup EXIT

docker build \
  --quiet \
  --iidfile "$iid_file" \
  --file "$repo_root/test/container/Dockerfile.enter-switch" \
  "$repo_root" >/dev/null

docker run --rm "$(cat "$iid_file")"
