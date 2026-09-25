#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != /* ]]; then
  echo 'usage: deploy/backup.sh /absolute/private/backup-directory' >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
env_file="${VANA_DEPLOY_ENV_FILE:-$script_dir/.env}"
if [[ ! -f "$env_file" ]]; then
  echo 'deploy/.env is required; copy env.example and set private values first' >&2
  exit 2
fi

backup_dir="$1"
umask 077
mkdir -p -- "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/vana-$stamp-$$.dump"
temporary="$(mktemp "$backup_dir/.vana-$stamp-XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT

docker compose --env-file "$env_file" -f "$script_dir/compose.yml" \
  exec -T db pg_dump -U vana -d vana --format=custom --no-owner --no-acl > "$temporary"
test -s "$temporary"
docker compose --env-file "$env_file" -f "$script_dir/compose.yml" \
  exec -T db pg_restore --list < "$temporary" > /dev/null
mv -- "$temporary" "$target"
trap - EXIT
echo "$target"
