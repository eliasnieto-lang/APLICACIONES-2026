#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
if [ -z "${TEXTOS_TEST_DIRECTOR_PASSWORD:-}" ]; then
  printf 'Provide TEXTOS_TEST_DIRECTOR_PASSWORD privately before running access database checks.\n' >&2
  exit 1
fi
task_id="textos-access-$$"
docker_local() { env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock "$@"; }
cleanup() { docker_local rm -fv "$task_id-rest" "$task_id-db" >/dev/null 2>&1 || true; docker_local network rm "$task_id-net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker_local network create "$task_id-net" >/dev/null
docker_local run -d --name "$task_id-db" --network "$task_id-net" --network-alias db -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-bookworm >/dev/null
for attempt in $(seq 1 60); do if docker_local exec "$task_id-db" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
docker_local exec -i "$task_id-db" psql -X -v ON_ERROR_STOP=1 -U postgres < supabase/bootstrap-local.sql >/dev/null
docker_local exec -i "$task_id-db" psql -X -v ON_ERROR_STOP=1 -U postgres < supabase/schema.sql >/dev/null
docker_local run -d --name "$task_id-rest" --network "$task_id-net" -p 127.0.0.1::3000 -e PGRST_DB_URI=postgres://authenticator@db/postgres -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon postgrest/postgrest:v12.2.3 >/dev/null
port=$(docker_local port "$task_id-rest" 3000/tcp | sed 's/^127\.0\.0\.1://')
ACCESS_DB="$task_id-db" ACCESS_URL="http://127.0.0.1:$port" node --import tsx tests/access-sql-integration.mjs
