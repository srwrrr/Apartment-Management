#!/usr/bin/env bash
# Restores a backup into a NEW, empty database. It refuses to overwrite one that has data in it.
# Usage:  scripts/restore.sh <backup.dump> <new-database-name> [uploads-folder-to-restore-into]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
read_env() { grep -E "^$1=" "$root/.env" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true; }

dump="${1:?Which backup file?}"
name="${2:?Which new database name?}"
target="${3:-}"
[ -s "$dump" ] || { echo "Backup not found or empty: $dump" >&2; exit 1; }
printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9_]*$' || { echo 'Use lower-case letters, digits and _ for the database name.' >&2; exit 1; }

url="${DATABASE_URL:-$(read_env DATABASE_URL)}"
url="${url%%\?*}"
base="${url%/*}"

exists="$(psql "$url" -tAc "SELECT 1 FROM pg_database WHERE datname = '$name'")"
[ -z "$exists" ] || { echo "Database $name already exists. Refusing to overwrite it." >&2; exit 1; }

psql "$url" -c "CREATE DATABASE $name" >/dev/null
pg_restore --no-owner --dbname="$base/$name" "$dump"

# The uploads folder saved next to this backup.
saved="$(dirname "$dump")/uploads-$(basename "$dump" .dump | sed 's/^apartment-//')"
if [ -n "$target" ] && [ -d "$saved" ]; then
  [ ! -e "$target" ] || [ -z "$(ls -A "$target")" ] || { echo "$target is not empty. Database restored, files not copied." >&2; exit 1; }
  mkdir -p "$target"
  cp -R "$saved/." "$target/"
fi
echo "Restored into $name"
