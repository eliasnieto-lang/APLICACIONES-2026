#!/usr/bin/env bash
set -euo pipefail
task_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$task_repo_root"
export CIRCULOS_PORT="${CIRCULOS_PORT:-3001}"
command -v docker >/dev/null || { printf '%s\n' 'Instala Docker Desktop o Docker Engine con Compose V2 antes de continuar.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf '%s\n' 'Abre Docker Desktop o inicia Docker Engine y vuelve a ejecutar este archivo.' >&2; exit 1; }
docker compose version >/dev/null
docker compose up --detach --build --wait --wait-timeout 180
printf 'Círculos está disponible en el puerto %s de esta computadora.\n' "$CIRCULOS_PORT"
printf '%s\n' 'Los datos se conservan en el volumen persistente de Docker.'
if command -v xdg-open >/dev/null; then
  xdg-open "http://127.0.0.1:$CIRCULOS_PORT"
elif command -v open >/dev/null; then
  open "http://127.0.0.1:$CIRCULOS_PORT"
fi
