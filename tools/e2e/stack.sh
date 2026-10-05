#!/bin/sh
# Builds and starts the local end-to-end stack from this checkout.
# Usage: tools/e2e/stack.sh up|down|rebuild|logs. Secrets live in a private env file
# outside the repository (VANA_E2E_ENV, default ~/.vana-e2e.env), created on first use.
set -eu
cd "$(dirname "$0")/../.."
envfile="${VANA_E2E_ENV:-$HOME/.vana-e2e.env}"
if [ ! -f "$envfile" ]; then
  umask 077
  cat > "$envfile" <<ENV
VANA_DOMAIN=http://localhost
VANA_DB_PASSWORD=$(openssl rand -hex 32)
VANA_WORLD_SEED=1
WORLD_HOURS_PER_REAL_HOUR=12
VANA_REWARD_NETWORK=base
VANA_REWARD_POLICY=first_valid
VANA_REWARD_ADMIN_TOKEN=$(openssl rand -hex 32)
VANA_LIVE_AGENTS=1
VANA_LIVE_SECRET=$(openssl rand -hex 32)
ENV
fi
compose() { docker compose --env-file "$envfile" -f deploy/compose.yml -f tools/e2e/compose.e2e.yml "$@"; }
case "${1:-up}" in
  up) compose up -d --build --wait ;;
  rebuild) compose build && compose up -d --wait ;;
  down) compose stop ;;
  logs) compose logs --tail=200 server ;;
  *) echo "usage: $0 up|down|rebuild|logs" >&2; exit 2 ;;
esac
