#!/usr/bin/env bash
# Import only into a new database. Never reconfigure or replace a running Kan.
set -Eeuo pipefail
umask 077
if [[ $# != 3 ]]; then echo "Usage: $0 <compose-env-file> <backup-directory> <new-database-name>" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/.." && pwd)
config=$(realpath "$1")
input=$(realpath "$2")
new_database=$3
[[ $new_database =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo 'Use a new lowercase database name.' >&2; exit 2; }
export COMPOSE_FILE=${COMPOSE_FILE:-$root/compose.yaml}
compose=(docker compose --env-file "$config")
# Validate the complete export before creating any destination.
python3 - "$input" <<'PY'
import hashlib, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root/'manifest.json').read_text())
if manifest.get('tool') != 'kan' or manifest.get('format') != 1:
    raise SystemExit('Not a supported Kan export.')
if not re.fullmatch(r'sha256:[a-f0-9]{64}', manifest.get('image', '')):
    raise SystemExit('Invalid source image ID.')
path = root/'database.dump'
if path.is_symlink() or hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() != manifest['sha256'].get('database.dump'):
    raise SystemExit('Export checksum mismatch: database.dump')
PY
database=$("${compose[@]}" ps --quiet postgres)
[[ -n $database && $database != *$'\n'* ]] || { echo 'Expected one running postgres.' >&2; exit 1; }
docker exec -i "$database" pg_restore --list > /dev/null < "$input/database.dump"
# createdb refuses an existing name, so live data cannot be overwritten.
docker exec -e RESTORE_DATABASE="$new_database" "$database" sh -c \
  'exec createdb -U "${POSTGRES_USER:?}" --maintenance-db "${POSTGRES_DB:?}" --template template0 -- "$RESTORE_DATABASE"'
restored=false
cleanup() {
  code=$?
  trap - EXIT
  if [[ $restored != true ]]; then
    docker exec -e RESTORE_DATABASE="$new_database" "$database" sh -c \
      'exec dropdb -U "${POSTGRES_USER:?}" --maintenance-db "${POSTGRES_DB:?}" -- "$RESTORE_DATABASE"' || code=1
  fi
  exit "$code"
}
trap cleanup EXIT
# Grants to existing roles are kept; a missing runtime role fails the whole restore.
docker exec -i -e RESTORE_DATABASE="$new_database" "$database" sh -c \
  'exec pg_restore -U "${POSTGRES_USER:?}" --dbname "$RESTORE_DATABASE" --no-owner --exit-on-error --single-transaction' < "$input/database.dump"
restored=true
printf 'Restored into database %s. Running apps were not changed.\n' "$new_database"
