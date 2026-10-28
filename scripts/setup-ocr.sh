#!/usr/bin/env bash
# Local, non-root Spanish OCR. Model: Apache-2.0, tesseract-ocr/tessdata_fast.
# Immutable upstream revision resolved from the official repository over HTTPS.
set -euo pipefail

task_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_tessdata="$task_repo_root/.tools/tessdata"
task_revision='87416418657359cb625c412a48b6e1d6d41c29bd'
task_sha256='6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464'
task_url="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$task_revision/spa.traineddata"

command -v tesseract >/dev/null || { printf '%s\n' 'Falta tesseract-ocr. Instale el paquete del sistema antes de continuar.' >&2; exit 1; }
mkdir -p "$task_tessdata"

if ! printf '%s  %s\n' "$task_sha256" "$task_tessdata/spa.traineddata" | sha256sum --check --status 2>/dev/null; then
  task_download="$(mktemp "$task_tessdata/spa.download.XXXXXX")"
  trap 'rm -f -- "$task_download"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 2 --connect-timeout 20 --max-time 120 \
    --output "$task_download" "$task_url"
  printf '%s  %s\n' "$task_sha256" "$task_download" | sha256sum --check --status
  chmod 644 "$task_download"
  mv -f -- "$task_download" "$task_tessdata/spa.traineddata"
  trap - EXIT
fi

# Keep the system's English fallback and orientation model available without copying or altering it.
task_system_tessdata="$(tesseract --list-langs 2>&1 | sed -n 's/^List of available languages in "\(.*\)".*/\1/p')"
for task_model in eng osd; do
  if [[ -f "$task_system_tessdata/$task_model.traineddata" && ! -e "$task_tessdata/$task_model.traineddata" ]]; then
    ln -s -- "$task_system_tessdata/$task_model.traineddata" "$task_tessdata/$task_model.traineddata"
  fi
done

tesseract --tessdata-dir "$task_tessdata" --list-langs
printf '%s\n' "OCR español instalado y verificado (SHA-256; revisión $task_revision)."
