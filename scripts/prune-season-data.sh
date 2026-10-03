#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target=""
keep_from=2026
apply=off
confirmation=""

usage() {
  echo "Usage: $0 --target=local|production [--keep-from=2026] [--confirm=TARGET-before-YEAR]"
  echo "Defaults to a dry run. Deletes scoped records before the retained NFL season."
}

for argument in "$@"; do
  case "$argument" in
    --target=*) target="${argument#*=}" ;;
    --keep-from=*) keep_from="${argument#*=}" ;;
    --confirm=*) confirmation="${argument#*=}"; apply=on ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $argument" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$target" != local && "$target" != production ]]; then
  echo "An explicit --target=local or --target=production is required." >&2
  exit 2
fi
if [[ ! "$keep_from" =~ ^[0-9]{4}$ ]] || ((keep_from < 1900 || keep_from > 2100)); then
  echo "--keep-from must be a year between 1900 and 2100." >&2
  exit 2
fi
if [[ "$apply" == on && "$confirmation" != "$target-before-$keep_from" ]]; then
  echo "Refusing deletion without --confirm=$target-before-$keep_from" >&2
  exit 2
fi

container="${LOCAL_DB_CONTAINER:-supabase_db_NFL_Data}"
host=""
if [[ "$target" == production ]]; then
  host="${DEPLOY_HOST:-glenn@192.168.4.237}"
  container="${REMOTE_DB_CONTAINER:-supabase-db}"
fi
if [[ ! "$container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "Invalid database container name." >&2
  exit 2
fi
echo "Target: $target ${host:-this-machine} / $container; retain $keep_from onward; apply=$apply"
if [[ "$target" == production ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    "docker exec -i $container psql -X -v ON_ERROR_STOP=1 -v keep_from=$keep_from -v apply=$apply -U postgres -d postgres" \
    < "$ROOT/scripts/prune-season-data.sql"
else
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 \
    -v keep_from="$keep_from" -v apply="$apply" -U postgres -d postgres \
    < "$ROOT/scripts/prune-season-data.sql"
fi
