#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-glenn@192.168.4.237}"
LOCAL_DB_CONTAINER="${LOCAL_DB_CONTAINER:-supabase_db_NFL_Data}"

remote_rows="$(ssh "$DEPLOY_HOST" "docker exec supabase-db psql -U postgres -d postgres -Atc \
  \"select coalesce(sum(n_live_tup), 0)::bigint from pg_stat_user_tables where schemaname = 'public'\"")"
if [[ "$remote_rows" != "0" ]]; then
  echo "Production public tables already contain approximately $remote_rows rows; refusing to overwrite them." >&2
  exit 1
fi

echo "Copying public-schema data from $LOCAL_DB_CONTAINER to production..."
docker exec "$LOCAL_DB_CONTAINER" pg_dump \
  -U postgres \
  -d postgres \
  --data-only \
  --schema=public \
  --no-owner \
  --no-privileges |
  ssh "$DEPLOY_HOST" "docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres"

echo "Production data import complete."
