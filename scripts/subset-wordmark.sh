#!/usr/bin/env bash
# Regenerates apps/web/app/fonts/wordmark.woff2: Space Grotesk Bold (SIL OFL, see wordmark-OFL.txt) cut down to the
# nine letters of the wordmark in the top bar (UI-15). Dev-time only: it installs fonttools into a throwaway
# environment with `uv`; nothing here is a dependency of the app. Needs network for the source font.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/src.woff2" \
  "https://cdn.jsdelivr.net/npm/@fontsource/space-grotesk@5.2.10/files/space-grotesk-latin-700-normal.woff2"
uv run --quiet --with fonttools --with brotli pyftsubset "$tmp/src.woff2" \
  --text="codearena" --flavor=woff2 --layout-features='kern' --no-hinting \
  --output-file=apps/web/app/fonts/wordmark.woff2
ls -l apps/web/app/fonts/wordmark.woff2
