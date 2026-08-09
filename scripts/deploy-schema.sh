#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-glenn@192.168.4.237}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/glenn/srv/nfl-data}"

ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH/supabase/migrations'"
rsync -az "$ROOT/supabase/migrations/" "$DEPLOY_HOST:$DEPLOY_PATH/supabase/migrations/"

ssh "$DEPLOY_HOST" "DEPLOY_PATH='$DEPLOY_PATH' bash -s" <<'REMOTE'
set -euo pipefail

psql_cmd=(docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres)
"${psql_cmd[@]}" <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
SQL

for migration in "$DEPLOY_PATH"/supabase/migrations/*.sql; do
  filename="$(basename "$migration" .sql)"
  version="${filename%%_*}"
  name="${filename#*_}"
  applied="$(docker exec supabase-db psql -U postgres -d postgres -Atc \
    "select 1 from supabase_migrations.schema_migrations where version = '$version'")"
  if [[ "$applied" == "1" ]]; then
    echo "Already applied: $filename"
    continue
  fi

  echo "Applying: $filename"
  "${psql_cmd[@]}" --single-transaction < "$migration"
  docker exec supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "insert into supabase_migrations.schema_migrations(version, name) values ('$version', '$name')"
done
REMOTE
