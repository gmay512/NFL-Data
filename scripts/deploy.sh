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

llm_base_url="${LLM_BASE_URL:-$(sed -n 's/^LLM_BASE_URL=//p' "$ROOT/.env.local" | tail -n 1)}"
llm_model="${LLM_MODEL:-$(sed -n 's/^LLM_MODEL=//p' "$ROOT/.env.local" | tail -n 1)}"
llm_timeout_ms="${LLM_TIMEOUT_MS:-$(sed -n 's/^LLM_TIMEOUT_MS=//p' "$ROOT/.env.local" | tail -n 1)}"
llm_max_context_chars="${LLM_MAX_CONTEXT_CHARS:-$(sed -n 's/^LLM_MAX_CONTEXT_CHARS=//p' "$ROOT/.env.local" | tail -n 1)}"
llm_max_output_tokens="${LLM_MAX_OUTPUT_TOKENS:-$(sed -n 's/^LLM_MAX_OUTPUT_TOKENS=//p' "$ROOT/.env.local" | tail -n 1)}"
llm_max_history_messages="${LLM_MAX_HISTORY_MESSAGES:-$(sed -n 's/^LLM_MAX_HISTORY_MESSAGES=//p' "$ROOT/.env.local" | tail -n 1)}"
llm_max_history_chars="${LLM_MAX_HISTORY_CHARS:-$(sed -n 's/^LLM_MAX_HISTORY_CHARS=//p' "$ROOT/.env.local" | tail -n 1)}"

llm_base_url="${llm_base_url:-http://192.168.4.241:8089}"
llm_model="${llm_model:-qwen3-coder-next}"
llm_timeout_ms="${llm_timeout_ms:-120000}"
llm_max_context_chars="${llm_max_context_chars:-240000}"
llm_max_output_tokens="${llm_max_output_tokens:-2048}"
llm_max_history_messages="${llm_max_history_messages:-12}"
llm_max_history_chars="${llm_max_history_chars:-24000}"

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
  printf 'LLM_BASE_URL=%s\n' "$llm_base_url"
  printf 'LLM_MODEL=%s\n' "$llm_model"
  printf 'LLM_TIMEOUT_MS=%s\n' "$llm_timeout_ms"
  printf 'LLM_MAX_CONTEXT_CHARS=%s\n' "$llm_max_context_chars"
  printf 'LLM_MAX_OUTPUT_TOKENS=%s\n' "$llm_max_output_tokens"
  printf 'LLM_MAX_HISTORY_MESSAGES=%s\n' "$llm_max_history_messages"
  printf 'LLM_MAX_HISTORY_CHARS=%s\n' "$llm_max_history_chars"
} | ssh "$DEPLOY_HOST" "umask 077; cat > '$DEPLOY_PATH/deploy/.env.production'"

ssh "$DEPLOY_HOST" "cd '$DEPLOY_PATH' && docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml up -d --build && docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml ps"
