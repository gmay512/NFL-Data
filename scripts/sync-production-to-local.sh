#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-glenn@192.168.4.237}"
REMOTE_DB_CONTAINER="${REMOTE_DB_CONTAINER:-supabase-db}"
LOCAL_DB_CONTAINER="${LOCAL_DB_CONTAINER:-supabase_db_NFL_Data}"
CONFIRMATION_PHRASE="production-to-local"

usage() {
  cat <<EOF
Usage: $(basename "$0") --confirm $CONFIRMATION_PHRASE

Resets the local Supabase database from repository migrations, then streams
production public-schema data into it and verifies every public table's row count.

Environment overrides:
  DEPLOY_HOST         SSH host (default: glenn@192.168.4.237)
  REMOTE_DB_CONTAINER Remote PostgreSQL container (default: supabase-db)
  LOCAL_DB_CONTAINER  Local PostgreSQL container (default: supabase_db_NFL_Data)
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 2 || $1 != "--confirm" || $2 != "$CONFIRMATION_PHRASE" ]]; then
  echo "Refusing to reset the local database without: --confirm $CONFIRMATION_PHRASE" >&2
  usage >&2
  exit 2
fi

for command_name in docker ssh supabase; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

for container_name in "$REMOTE_DB_CONTAINER" "$LOCAL_DB_CONTAINER"; do
  if [[ ! $container_name =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    echo "Invalid container name: $container_name" >&2
    exit 1
  fi
done

remote_container_q="$(printf '%q' "$REMOTE_DB_CONTAINER")"

verify_remote() {
  local running
  running="$(ssh "$DEPLOY_HOST" \
    "docker inspect --format='{{.State.Running}}' $remote_container_q")"
  if [[ $running != "true" ]]; then
    echo "Remote database container is not running: $REMOTE_DB_CONTAINER" >&2
    exit 1
  fi
  ssh "$DEPLOY_HOST" \
    "docker exec $remote_container_q psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'select 1'" \
    | grep -qx '1'
  ssh "$DEPLOY_HOST" "docker exec $remote_container_q pg_dump --version" >/dev/null
}

verify_local() {
  local running
  running="$(docker inspect --format='{{.State.Running}}' "$LOCAL_DB_CONTAINER")"
  if [[ $running != "true" ]]; then
    echo "Local database container is not running: $LOCAL_DB_CONTAINER" >&2
    exit 1
  fi
  docker exec "$LOCAL_DB_CONTAINER" \
    psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'select 1' |
    grep -qx '1'
}

read -r -d '' count_sql <<'SQL' || true
SELECT format(
  'SELECT %L || chr(9) || count(*)::text FROM %I.%I;',
  n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname
\gexec
SQL

echo "Verifying production and local database containers..."
verify_remote
verify_local

echo "Resetting local Supabase schema from repository migrations..."
(
  cd "$ROOT"
  supabase db reset --local
)
verify_local

echo "Streaming production public-schema data into the local database..."
ssh "$DEPLOY_HOST" \
  "docker exec $remote_container_q pg_dump -U postgres -d postgres --data-only --schema=public --no-owner --no-privileges" |
  docker exec -i "$LOCAL_DB_CONTAINER" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres

echo "Comparing exact row counts for every public table..."
remote_counts="$(
  printf '%s\n' "$count_sql" |
    ssh "$DEPLOY_HOST" \
      "docker exec -i $remote_container_q psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d postgres"
)"
local_counts="$(
  printf '%s\n' "$count_sql" |
    docker exec -i "$LOCAL_DB_CONTAINER" \
      psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d postgres
)"

if [[ $remote_counts != "$local_counts" ]]; then
  echo "Production and local public-table row counts do not match:" >&2
  diff -u \
    <(printf '%s\n' "$remote_counts") \
    <(printf '%s\n' "$local_counts") >&2 || true
  exit 1
fi

table_count="$(printf '%s\n' "$local_counts" | awk 'NF { count++ } END { print count + 0 }')"
echo "Sync complete; verified exact row counts for $table_count public tables."
