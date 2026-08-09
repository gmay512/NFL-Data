#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-glenn@192.168.4.237}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/glenn/srv/nfl-data}"
SUPABASE_PATH="${SUPABASE_PATH:-/home/glenn/srv/supabase-project}"
PUBLIC_URL="${PUBLIC_URL:-http://192.168.4.237}"

if [[ ! -f "$ROOT/.env.local" ]]; then
  echo "Missing $ROOT/.env.local" >&2
  exit 1
fi

api_sports_key="$(sed -n 's/^API_SPORTS_KEY=//p' "$ROOT/.env.local" | tail -n 1)"
if [[ -z "$api_sports_key" ]]; then
  echo "API_SPORTS_KEY is missing from .env.local" >&2
  exit 1
fi

mapfile -t supabase_keys < <(ssh "$DEPLOY_HOST" \
  "sed -n 's/^ANON_KEY=//p; s/^SERVICE_ROLE_KEY=//p' '$SUPABASE_PATH/.env'")
if [[ ${#supabase_keys[@]} -ne 2 || -z "${supabase_keys[0]}" || -z "${supabase_keys[1]}" ]]; then
  echo "Could not read Supabase keys from the server" >&2
  exit 1
fi

ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH'"
rsync -az --delete \
  --exclude=.git \
  --exclude=.env.local \
  --exclude=deploy/.env.production \
  --exclude=dist \
  --exclude=node_modules \
  --exclude=supabase/.branches \
  --exclude=supabase/.temp \
  "$ROOT/" "$DEPLOY_HOST:$DEPLOY_PATH/"

{
  printf 'VITE_SUPABASE_URL=%s\n' "$PUBLIC_URL"
  printf 'VITE_SUPABASE_ANON_KEY=%s\n' "${supabase_keys[0]}"
  printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "${supabase_keys[1]}"
  printf 'API_SPORTS_KEY=%s\n' "$api_sports_key"
  printf 'API_SPORTS_BASE_URL=%s\n' 'https://v1.american-football.api-sports.io'
  printf 'API_SPORTS_HOST=%s\n' 'v1.american-football.api-sports.io'
  printf 'API_SPORTS_LEAGUE_ID=%s\n' '1'
} | ssh "$DEPLOY_HOST" "umask 077; cat > '$DEPLOY_PATH/deploy/.env.production'"

ssh "$DEPLOY_HOST" "cd '$DEPLOY_PATH' && docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml up -d --build && docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml ps"
