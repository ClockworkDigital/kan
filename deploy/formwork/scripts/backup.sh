#!/usr/bin/env bash
# Export Kan's database from one consistent snapshot. Containers keep running unchanged.
set -Eeuo pipefail
umask 077
if [[ $# != 2 ]]; then echo "Usage: $0 <compose-env-file> <new-output-directory>" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/.." && pwd)
config=$(realpath "$1")
output=$(realpath -m "$2")
export COMPOSE_FILE=${COMPOSE_FILE:-$root/compose.yaml}
compose=(docker compose --env-file "$config")
web=$("${compose[@]}" ps --all --quiet web)
database=$("${compose[@]}" ps --quiet postgres)
[[ -n $web && $web != *$'\n'* && -n $database && $database != *$'\n'* ]] || {
  echo 'Expected one Kan web container and one running postgres.' >&2
  exit 1
}
image=$(docker inspect --format '{{.Image}}' "$web")
mkdir "$output"
complete=false
cleanup() {
  code=$?
  trap - EXIT
  [[ $complete == true ]] || rm -rf -- "$output"
  exit "$code"
}
trap cleanup EXIT
# The container's local socket needs no password; ACLs keep runtime-role grants.
docker exec "$database" sh -c 'exec pg_dump -U "${POSTGRES_USER:?}" -d "${POSTGRES_DB:?}" --format=custom' > "$output/database.dump"
docker exec -i "$database" pg_restore --list > /dev/null < "$output/database.dump"
server=$(docker exec "$database" sh -c 'exec psql -X -qAt -U "${POSTGRES_USER:?}" -d "${POSTGRES_DB:?}" -c "SHOW server_version_num"')
python3 - "$output" "$image" "$server" <<'PY'
import hashlib, json, pathlib, sys
from datetime import datetime, timezone
output = pathlib.Path(sys.argv[1])
manifest = {'tool': 'kan', 'format': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
            'image': sys.argv[2], 'postgres_version_num': int(sys.argv[3]),
            'sha256': {'database.dump': hashlib.file_digest((output/'database.dump').open('rb'), 'sha256').hexdigest()}}
(output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
PY
complete=true
echo "Kan export saved to $output"
