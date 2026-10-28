#!/usr/bin/env bash
set -euo pipefail
task_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_repo_root"
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Se necesita Node.js 24 o superior."); process.exit(1); }'
for task_tool in pdftotext pdfinfo pdftoppm pdfimages tesseract curl sha256sum; do
  command -v "$task_tool" >/dev/null || { printf 'Falta %s. Instale poppler-utils, tesseract-ocr, curl y coreutils.\n' "$task_tool" >&2; exit 1; }
done
npm ci --cache "${CIRCULOS_NPM_CACHE:-/tmp/circulos-npm-cache}" --no-audit --no-fund
bash scripts/setup-ocr.sh
npm run build
