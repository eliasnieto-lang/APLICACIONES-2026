#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /app-schema/bootstrap-local.sql
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --set=pgrst_password="$PGRST_PASSWORD" <<'SQL'
ALTER ROLE authenticator WITH LOGIN PASSWORD :'pgrst_password';
SQL
