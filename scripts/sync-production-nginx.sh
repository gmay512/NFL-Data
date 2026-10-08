#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_file="$ROOT/deploy/nginx.conf"
site="${NGINX_SITE_PATH:-/etc/nginx/sites-enabled/supabase}"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --check ) ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 1
fi
if [[ ! -r "$source_file" || ! -f "$site" || ! -r "$site" ]]; then
  echo "Both $source_file and the enabled nginx site $site must exist and be readable." >&2
  echo "For a first installation, create and enable the intended site before deploying." >&2
  exit 1
fi

if cmp -s -- "$source_file" "$site"; then
  echo "Installed nginx site matches deploy/nginx.conf; no reload required."
  exit 0
fi
if [[ "${1:-}" == --check ]]; then
  echo "Installed nginx site differs from deploy/nginx.conf." >&2
  exit 3
fi
if [[ "$(id -u)" != 0 ]]; then
  echo "Updating the nginx site requires sudo: sudo bash '$ROOT/scripts/sync-production-nginx.sh'" >&2
  exit 1
fi

target="$(readlink -e -- "$site")"
if [[ ! -f "$target" ]]; then
  echo "The enabled nginx site must resolve to an existing regular file." >&2
  exit 1
fi
nginx -t
backup="$(mktemp "${TMPDIR:-/var/tmp}/nfl-data-nginx.XXXXXX")"
if ! cp -p -- "$target" "$backup"; then
  rm -f -- "$backup"
  echo "Could not back up the existing nginx site; no configuration was changed." >&2
  exit 1
fi
changed=false
keep_backup=false

restore() {
  echo "Restoring the previous nginx site." >&2
  if ! cp -p -- "$backup" "$target" || ! nginx -t || ! systemctl reload nginx; then
    keep_backup=true
    echo "Nginx rollback failed. The previous site is retained at $backup; manual recovery is required." >&2
    return 1
  fi
  changed=false
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$changed" == true ]]; then
    restore || status=1
  fi
  if [[ "$keep_backup" == false ]]; then
    rm -f -- "$backup"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

changed=true
if ! cp -- "$source_file" "$target"; then
  echo "Could not install the desired nginx site." >&2
  exit 1
fi
if ! nginx -t; then
  echo "The desired nginx site failed validation; it will not be activated." >&2
  exit 1
fi
if ! systemctl reload nginx; then
  echo "Nginx reload failed; restoring the previous site." >&2
  exit 1
fi
if ! cmp -s -- "$source_file" "$site"; then
  echo "The installed nginx site changed unexpectedly during synchronization." >&2
  exit 1
fi
changed=false
echo "Installed, validated, and reloaded the production nginx site."
