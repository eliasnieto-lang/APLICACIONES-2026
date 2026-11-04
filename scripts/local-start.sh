#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p local
if [ ! -f local/.env ]; then
  node --input-type=module <<'JS'
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
writeFileSync('local/.env',`POSTGRES_PASSWORD=${randomBytes(30).toString('hex')}\nPGRST_PASSWORD=${randomBytes(30).toString('hex')}\nTEXTOS_PORT=8080\n`,{mode:0o600});
JS
fi
docker compose --env-file local/.env up -d --wait db
# Apply idempotent roles/migration after the final PostgreSQL TCP server is ready.
# This also repairs an interrupted first installation without deleting its data.
docker compose --env-file local/.env exec -T db sh /docker-entrypoint-initdb.d/10-textos.sh >/dev/null
docker compose --env-file local/.env exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d textos -f /app-schema/schema.sql >/dev/null
if [ -n "${CODEX_PROXY_CERT:-}" ] && [ -f "$CODEX_PROXY_CERT" ]; then
  docker build --secret "id=proxy_ca,src=$CODEX_PROXY_CERT" -t seleccion-textos-2027-web:local .
  docker compose --env-file local/.env up -d --no-build --wait
else
  docker compose --env-file local/.env up -d --build --wait
fi
if [ ! -s local/owner-code.txt ]; then
  docker compose --env-file local/.env exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d textos -Atc "select public.textos_bootstrap_local('real');" >local/owner-code.txt
  chmod 600 local/owner-code.txt
fi
if [ ! -s local/demo-owner-code.txt ]; then
  docker compose --env-file local/.env exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d textos -Atc "select public.textos_bootstrap_local('demo');" >local/demo-owner-code.txt
  chmod 600 local/demo-owner-code.txt
fi
printf '\nSistema iniciado. Abre http://localhost:8080 en esta computadora.\n'
printf 'El código privado de coordinación está en local/owner-code.txt. No lo publiques.\n'
printf 'Para verlo aquí: cat local/owner-code.txt\n'
