#!/usr/bin/env bash
# Upgrade-and-rollback drill on a COPY of the local end-to-end world (the rollback drill of 5 October 2026).
#
#   tools/ops/rollback-drill.sh [--old-ref REF] [--new-ref REF] [--keep]
#
# 1. Back up the source world with deploy/backup.sh (read-only pg_dump of the vana-e2e database).
# 2. Build the "previous" images from --old-ref (default feat/full-scope) and the "new" ones from
#    --new-ref (default HEAD), each from `git archive`, so only committed code goes in.
# 3. Restore the backup into a separate compose project, vana-drill (own volumes, loopback port
#    28090), start the previous image, and put live possessions and a reward allocation on it.
# 4. Take the pre-upgrade backup with deploy/backup.sh, start the new image, check health, world
#    progress, identity, the reward ledger and possessions.
# 5. Roll back: stop, restore the pre-upgrade backup, start the previous image, check it all again.
#
# Never touches the vana-staging-* or vana-e2e volumes or containers (the source is only read
# with pg_dump). Secrets stay in private files under the drill directory and are never printed.
# The drill copy shares the source's world identity (that is what it checks), so it listens on
# loopback only and is removed at the end unless --keep is given.
set -euo pipefail

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
old_ref=feat/full-scope new_ref=HEAD keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --old-ref) old_ref="$2"; shift 2 ;;
    --new-ref) new_ref="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    *) echo "usage: $0 [--old-ref REF] [--new-ref REF] [--keep]" >&2; exit 2 ;;
  esac
done

project=vana-drill
port="${VANA_DRILL_PORT:-28090}"
source_project="${VANA_DRILL_SOURCE_PROJECT:-vana-e2e}"
source_env="${VANA_E2E_ENV:-$HOME/.vana-e2e.env}"
case "$source_project" in vana-staging*) echo "refusing to read a staging project" >&2; exit 2 ;; esac
[[ "$project" != "$source_project" ]] || { echo "drill project must differ from the source" >&2; exit 2; }
[[ -f "$source_env" ]] || { echo "source env file not found" >&2; exit 2; }
if docker volume ls -q | grep -qx "${project}_db_data"; then
  echo "${project}_db_data already exists; remove the previous drill first (docker compose -p $project down -v)" >&2; exit 2
fi

umask 077
dir="$(mktemp -d "${TMPDIR:-/tmp}/vana-rollback-drill.XXXXXX")"
evidence="$dir/evidence.txt"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$evidence"; }
fail() { log "FAIL: $*"; exit 1; }

cat > "$dir/drill.env" <<ENV
VANA_DOMAIN=http://localhost
VANA_DB_PASSWORD=$(openssl rand -hex 32)
VANA_WORLD_SEED=1
WORLD_HOURS_PER_REAL_HOUR=120
VANA_REWARD_NETWORK=base
VANA_REWARD_POLICY=first_valid
VANA_REWARD_ADMIN_TOKEN=$(openssl rand -hex 32)
VANA_LIVE_AGENTS=1
VANA_LIVE_SECRET=$(openssl rand -hex 32)
VANA_AGENT_REGISTRATIONS_PER_NETWORK=100
VANA_DRILL_PORT=$port
ENV
cat > "$dir/compose.drill.yml" <<'YML'
# The production compose file with pinned images and a loopback-only port.
name: vana-drill
services:
  server:
    image: ${VANA_DRILL_SERVER_IMAGE:?}
  web:
    image: ${VANA_DRILL_WEB_IMAGE:?}
    ports: !override
      - "127.0.0.1:${VANA_DRILL_PORT}:80"
YML
compose() { COMPOSE_PROJECT_NAME="$project" docker compose --env-file "$dir/drill.env" -f "$root/deploy/compose.yml" -f "$dir/compose.drill.yml" "$@"; }
use() { export VANA_DRILL_SERVER_IMAGE="vana-drill-server:$1" VANA_DRILL_WEB_IMAGE="vana-drill-web:$1"; }
# Caddy serves the site under its configured name (VANA_DOMAIN=http://localhost), not 127.0.0.1.
sql() { compose exec -T db psql -U vana -d vana -v ON_ERROR_STOP=1 -Atc "$1"; }
api() { curl -fsS --max-time 10 "http://localhost:$port/api$1"; }
admin() { curl -fsS --max-time 10 -H "authorization: Bearer $(sed -n 's/^VANA_REWARD_ADMIN_TOKEN=//p' "$dir/drill.env")" \
  -H 'content-type: application/json' --data "$2" "http://localhost:$port/api$1"; }
started() { docker inspect -f '{{.State.StartedAt}}' "$1"; }

log "drill directory $dir"
log "source $source_project; old ref $old_ref ($(git -C "$root" rev-parse --short "$old_ref")); new ref $new_ref ($(git -C "$root" rev-parse --short "$new_ref"))"
source_started="$(started "${source_project}-server-1") $(started "${source_project}-db-1")"

# 1. Back up the source world, exactly as the operator's daily backup does.
source_dump="$(COMPOSE_PROJECT_NAME="$source_project" VANA_DEPLOY_ENV_FILE="$source_env" "$root/deploy/backup.sh" "$dir/backups")"
log "source backup $(basename "$source_dump") $(wc -c < "$source_dump" | tr -d ' ') bytes"

# 2. Previous and new images, from committed code only.
for tag in old new; do
  ref=$old_ref; [[ $tag == new ]] && ref=$new_ref
  git -C "$root" archive --format=tar "$ref" > "$dir/$tag.tar"
  docker build -q -f deploy/Dockerfile.server -t "vana-drill-server:$tag" - < "$dir/$tag.tar" > /dev/null
  docker build -q -f deploy/Dockerfile.web -t "vana-drill-web:$tag" - < "$dir/$tag.tar" > /dev/null
  log "built vana-drill-server:$tag $(docker image inspect -f '{{.Id}}' "vana-drill-server:$tag" | cut -c8-19) from $ref"
done

# 3. A copy of the source world on the previous image.
use old
compose up -d --wait db
compose exec -T db pg_restore -U vana -d vana --no-owner --no-acl < "$source_dump" || fail "restore of the source backup"
compose up -d --no-build --wait server web
log "previous image up: $(api /health)"

state() { # label: everything that must survive, as one comparable line per item
  local label="$1"
  {
    echo "identity $(sql "select world_id || ' founded ' || founded_at from world_identity")"
    echo "snapshots $(sql "select count(*) || ' latest ' || coalesce(max(world_time),-1) from snapshots")"
    echo "reward_drops $(sql "select count(*) || ' ' || md5(coalesce(string_agg(id::text || status || amount_micro, ',' order by id), '')) from reward_drops")"
    echo "reward_claims $(sql "select count(*) || ' ' || md5(coalesce(string_agg(id::text || status, ',' order by id), '')) from reward_claims")"
    echo "reward_audit $(sql "select count(*) || ' ' || md5(coalesce(string_agg(id::text || action, ',' order by id), '')) from reward_audit")"
    echo "live_agents $(sql "select count(*) || ' ' || md5(coalesce(string_agg(id, ',' order by id), '')) from live_agents")"
    echo "live_possessions $(sql "select count(*) || ' ' || coalesce(string_agg(agent_id || '=' || animal_id, ',' order by agent_id), '') from live_possessions")"
  } > "$dir/state-$label.txt"
  sed "s/^/  [$label] /" "$dir/state-$label.txt" | tee -a "$evidence"
}
same() { # label-a label-b item: the item must be identical in both
  local a b; a="$(grep "^$3 " "$dir/state-$1.txt")"; b="$(grep "^$3 " "$dir/state-$2.txt")"
  [[ "$a" == "$b" ]] || fail "$3 differs between $1 and $2: '$a' vs '$b'"
  log "ok: $3 unchanged ($2 = $1)"
}
progress() { # the saved world clock must move on
  local t0 t1; t0="$(api /health | sed -E 's/.*"worldTime":([0-9]+).*/\1/')"
  for _ in $(seq 1 30); do sleep 5; t1="$(api /health | sed -E 's/.*"worldTime":([0-9]+).*/\1/')"; [[ "$t1" -gt "$t0" ]] && break; done
  [[ "$t1" -gt "$t0" ]] || fail "world time did not advance from $t0"
  log "ok: world time advanced $t0 -> $t1"
}
booted() { # the server must have restored the saved world, never founded a new one
  local logs; logs="$(compose logs --no-log-prefix server 2>&1 | tail -n 200)"
  grep -q 'booted a fresh world' <<<"$logs" && fail "the server founded a new world"
  grep -q 'restored world at' <<<"$logs" || fail "no restore line in the server log"
  log "ok: $(grep -o 'restored world at [0-9]*, rolled back [0-9]* events' <<<"$logs" | tail -n 1)"
}
booted; progress
state copy

# Live possessions and a reward allocation made on the previous image.
agents="$dir/agents"; mkdir -p "$agents"
for name in drill-a drill-b drill-c; do
  mkdir -p "$agents/$name"
  HOME="$agents/$name" VANA_URL="http://localhost:$port/api" VANA_PROFILE=drill node --input-type=module -e "
    const { api } = await import('$root/packages/server/agent-client/client.mjs');
    await api.register('$name', 'Rollback drill agent.');
    const p = await api.possess('chital');
    if (!p.animalId) throw new Error('not possessed: ' + JSON.stringify(p));
    const o = await api.observe();
    await api.move([{ x: o.animal.position.x + 15, z: o.animal.position.z + 15 }], 'walk');
    console.log('$name steers ' + p.animalId);" | tee -a "$evidence"
done
animal="$(api /animals | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).animals[0].id))')"
admin /admin/rewards/drops "{\"id\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"actorId\":\"$animal\",\"amount\":\"0.25\",\"revealWhen\":\"watch\"}" > /dev/null
admin /admin/rewards/place-drops "{\"batchId\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"amount\":\"0.50\",\"count\":2,\"spacingMinutes\":0,\"lifetimeMinutes\":120}" > /dev/null
sleep 12 # Possessions are saved every 10 s.
state before-upgrade
[[ "$(grep '^live_possessions ' "$dir/state-before-upgrade.txt" | cut -d' ' -f2)" -ge 3 ]] || fail "possessions were not saved"

# 4. Upgrade: back up, then the new image on the same database.
pre_dump="$(COMPOSE_PROJECT_NAME="$project" VANA_DEPLOY_ENV_FILE="$dir/drill.env" "$root/deploy/backup.sh" "$dir/backups")"
log "pre-upgrade backup $(basename "$pre_dump") $(wc -c < "$pre_dump" | tr -d ' ') bytes"
use new
compose up -d --no-build --wait server web
log "new image up: $(api /health) image $(docker inspect -f '{{.Image}}' "$project-server-1" | cut -c8-19)"
booted; progress
sleep 12
state upgraded
for item in identity reward_drops reward_claims reward_audit live_agents live_possessions; do same before-upgrade upgraded "$item"; done
log "new image metrics: $(compose exec -T server wget -qO- http://127.0.0.1:9464/metrics | grep -E '^vana_(world_info|live_avatars|ws_connections) ' | tr '\n' ' ' || echo 'none')"
log "new image /api/metrics through Caddy: HTTP $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/api/metrics")"
# A write made after the backup: a rollback to the backup is expected to lose it.
admin /admin/rewards/place-drops "{\"batchId\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"amount\":\"1.00\",\"count\":1,\"spacingMinutes\":0,\"lifetimeMinutes\":60}" > /dev/null
log "after-backup write on the new image: reward_drops now $(sql 'select count(*) from reward_drops')"

# 5. Roll back: previous image and the pre-upgrade backup.
compose stop server web
compose exec -T db dropdb -U vana vana
compose exec -T db createdb -U vana vana
compose exec -T db pg_restore -U vana -d vana --no-owner --no-acl < "$pre_dump" || fail "restore of the pre-upgrade backup"
use old
compose up -d --no-build --wait server web
log "rolled back: $(api /health) image $(docker inspect -f '{{.Image}}' "$project-server-1" | cut -c8-19)"
booted; progress
sleep 12
state rolled-back
for item in identity reward_drops reward_claims reward_audit live_agents live_possessions; do same before-upgrade rolled-back "$item"; done
[[ "$(api /agents/playing | grep -o '"agentId"' | wc -l | tr -d ' ')" -ge 3 ]] || fail "possessed animals are not playing after the rollback"
log "ok: $(api /agents/playing | grep -o '"agentId"' | wc -l | tr -d ' ') agents playing after the rollback"

[[ "$(started "${source_project}-server-1") $(started "${source_project}-db-1")" == "$source_started" ]] || fail "the source stack was restarted"
log "ok: source $source_project untouched (same container start times)"
log "DRILL PASSED"

if [[ $keep -eq 0 ]]; then
  [[ "$project" == vana-drill ]] && compose down -v --remove-orphans > /dev/null 2>&1
  docker image rm vana-drill-server:old vana-drill-server:new vana-drill-web:old vana-drill-web:new > /dev/null
  rm -f "${dir:?}"/*.tar "${dir:?}/drill.env"
  log "drill project, volumes and images removed; evidence kept in $evidence"
fi
