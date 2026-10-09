#!/usr/bin/env bash
# UI-07: installs the design skills Claude Code uses for the redesign (docs/design-skills.md says what each is for).
# Project scope, Claude Code only, no sudo, idempotent: a source whose skills are already in .claude/skills is skipped
# (FORCE=1 reinstalls everything). The skill files are third-party and are NOT committed (.claude/skills/ is ignored);
# this script reproduces them.
#
#   scripts/setup-design-skills.sh            install what is missing
#   FORCE=1 scripts/setup-design-skills.sh    reinstall all
#
# Before relying on a flag it reads the tool's own --help, and stops with a message if the flag is gone, so a change in
# a tool shows up here and not as a half-installed setup. Adapt the flags, and note the difference in docs/design-skills.md.
# taste is deliberately not installed here (its repository has no LICENSE file); see docs/design-skills.md.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v npx >/dev/null || { echo "npx (Node.js) is required" >&2; exit 1; }
SKILLS="npx --yes skills@latest"
FORCE="${FORCE:-0}"
DIR=".claude/skills"
mkdir -p "$DIR"

say() { printf '\n== %s\n' "$*"; }
missing=0

# Stops unless every flag is mentioned in `$1 --help` (the rest of the arguments).
need_flags() {
  local help="$1"; shift
  local out
  out="$($help --help 2>&1 || true)"
  for f in "$@"; do
    grep -q -- "$f" <<<"$out" || { echo "✗ '$help' no longer lists the flag $f; read '$help --help', adapt this script and note the difference in docs/design-skills.md" >&2; exit 1; }
  done
}

# True when every named skill directory is already installed (so the source can be skipped).
installed() {
  local s
  for s in "$@"; do [ -f "$DIR/$s/SKILL.md" ] || return 1; done
}

EMIL=(emil-design-eng apple-design animate review-animations improve-animations find-animation-opportunities animation-vocabulary break-ui mobile-native prototype pick-ui-library)

say "1. Emil Kowalski's skills (MIT): https://github.com/emilkowalski/skills"
need_flags "$SKILLS add" -a -y --copy --skill --list
if [ "$FORCE" != 1 ] && installed "${EMIL[@]}"; then
  echo "already installed: ${EMIL[*]}"
else
  # not installed on purpose: animate-expo, write-swift, ask-sonner (React Native, Swift, a toast library we do not use)
  $SKILLS add emilkowalski/skills --list
  $SKILLS add emilkowalski/skills -a claude-code -y --copy --skill "${EMIL[@]}"
fi

say "2. Impeccable (Apache-2.0): https://github.com/pbakaus/impeccable (npm package 'impeccable')"
need_flags "npx --yes impeccable install" --providers --scope --no-hooks
# --no-hooks on purpose: the hooks download and run a binary on every edit. To enable them later, see docs/design-skills.md.
if [ "$FORCE" != 1 ] && [ -d ".impeccable" -o -f "$DIR/impeccable/SKILL.md" ]; then
  echo "already installed (.impeccable or .claude/skills/impeccable exists)"
else
  force=(); [ "$FORCE" = 1 ] && force=(--force)
  npx --yes impeccable install --providers=claude --scope=project --no-hooks "${force[@]}"
fi

say "3. hairline (MIT): https://github.com/lucasmarkes/hairline"
if [ "$FORCE" != 1 ] && installed hairline-create; then
  echo "already installed: hairline-create"
else
  $SKILLS add lucasmarkes/hairline --list
  $SKILLS add lucasmarkes/hairline -a claude-code -y --copy
fi

say "check"
for s in "${EMIL[@]}" hairline-create; do
  if [ -f "$DIR/$s/SKILL.md" ]; then echo "✓ $s"; else echo "✗ $s is not in $DIR"; missing=1; fi
done
[ -d ".impeccable" ] || [ -f "$DIR/impeccable/SKILL.md" ] && echo "✓ impeccable" || { echo "✗ impeccable did not leave .impeccable or .claude/skills/impeccable"; missing=1; }
echo
echo "Restart Claude Code (/exit, then claude) so the new skills load."
echo "Not installed here: taste (no LICENSE file in its repository); see docs/design-skills.md for the two commands Ayush runs himself."
exit "$missing"
