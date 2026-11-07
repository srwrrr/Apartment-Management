#!/usr/bin/env bash
# NFR-15: one backup of the database and the uploaded files, keeping the last 7 days.
# Usage (from the repo root):  scripts/backup.sh [backup-folder]
# Schedule it daily with cron (see docs/backup-and-restore.md).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
read_env() { grep -E "^$1=" "$root/.env" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true; }

url="${DATABASE_URL:-$(read_env DATABASE_URL)}"
[ -n "$url" ] || { echo 'DATABASE_URL not found. Set it in .env.' >&2; exit 1; }
url="${url%%\?*}" # pg_dump does not understand Prisma's extra options

dir="${1:-$root/backups}"
mkdir -p "$dir"
stamp="$(date +%F)"
dump="$dir/apartment-$stamp.dump"

pg_dump -Fc --no-owner --dbname="$url" -f "$dump"
[ -s "$dump" ] || { echo 'The backup file is empty.' >&2; exit 1; }

# The photos and receipts belong with the database that points at them.
uploads="${UPLOAD_DIR:-$(read_env UPLOAD_DIR)}"
uploads="${uploads:-./uploads}"
case "$uploads" in /*|[A-Za-z]:*) ;; *) uploads="$root/server/$uploads" ;; esac
if [ -d "$uploads" ]; then
  rm -rf "$dir/uploads-$stamp"
  cp -R "$uploads" "$dir/uploads-$stamp"
fi

find "$dir" -maxdepth 1 -name 'apartment-*.dump' -mtime +7 -delete
find "$dir" -maxdepth 1 -type d -name 'uploads-*' -mtime +7 -exec rm -rf {} +
echo "Backup written: $dump"
