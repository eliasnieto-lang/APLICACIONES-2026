#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker compose --env-file local/.env stop
printf 'Sistema detenido. Los datos permanecen en el volumen textos_data.\n'
