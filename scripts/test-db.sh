#!/bin/sh
# Isolated acceptance stack: never reads local/.env or touches a school database.
set -eu
cd "$(dirname "$0")/.."
test_id="textos-acceptance-$$"
docker_local() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock "$@"
}
cleanup() {
  result=$?
  trap - EXIT INT TERM
  docker_local rm -fv "$test_id-rest" "$test_id-db" >/dev/null 2>&1 || true
  docker_local network rm "$test_id-net" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT INT TERM
docker_local network create "$test_id-net" >/dev/null
docker_local run -d --name "$test_id-db" --network "$test_id-net" --network-alias db -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-bookworm >/dev/null
attempt=0
until docker_local exec "$test_id-db" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 60 ] || { printf 'La base de prueba no inició.\n' >&2; exit 1; }
  sleep 1
done
docker_local exec -i "$test_id-db" psql -X -v ON_ERROR_STOP=1 -U postgres < supabase/bootstrap-local.sql >/dev/null
docker_local exec -i "$test_id-db" psql -X -v ON_ERROR_STOP=1 -U postgres < supabase/schema.sql >/dev/null
docker_local run -d --name "$test_id-rest" --network "$test_id-net" -p 127.0.0.1::3000 -e PGRST_DB_URI=postgres://authenticator@db/postgres -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon postgrest/postgrest:v12.2.3 >/dev/null
test_port=$(docker_local port "$test_id-rest" 3000/tcp | sed 's/^127\.0\.0\.1://')
TEXTOS_TEST_DB_CONTAINER="$test_id-db" TEXTOS_TEST_REST_CONTAINER="$test_id-rest" TEXTOS_TEST_REST_URL="http://127.0.0.1:$test_port" node --import tsx tests/sql-integration.mjs
