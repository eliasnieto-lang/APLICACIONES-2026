#!/usr/bin/env bash
# Download the official Spanish OCR model for both server and browser builds.
set -euo pipefail
task_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_tessdata="$task_repo_root/.tools/tessdata"
task_revision='87416418657359cb625c412a48b6e1d6d41c29bd'
task_sha256='6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464'
task_url="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$task_revision/spa.traineddata"
mkdir -p "$task_tessdata"
if ! printf '%s  %s\n' "$task_sha256" "$task_tessdata/spa.traineddata" | sha256sum --check --status 2>/dev/null; then
  task_download="$(mktemp "$task_tessdata/spa.download.XXXXXX")"
  trap 'rm -f -- "$task_download"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 2 --connect-timeout 20 --max-time 120 --output "$task_download" "$task_url"
  printf '%s  %s\n' "$task_sha256" "$task_download" | sha256sum --check --status
  chmod 644 "$task_download"
  mv -f -- "$task_download" "$task_tessdata/spa.traineddata"
  trap - EXIT
fi
printf '%s\n' 'Modelo OCR español verificado (SHA-256).'
