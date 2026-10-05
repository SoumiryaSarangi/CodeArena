# PROGRESS

## 2026-10-05 · F-01 · done
- Built: pnpm workspace + Turborepo; apps web/api/worker/collab/plag (hello-worlds); packages config/contracts; lefthook, lint-staged, eslint, prettier; `.claude/settings.json` denying `.env*`; `.env.example` per app; PR template. Docs moved to `docs/` (U0.5); CLAUDE.md Opus line set to yes.
- Tests: `pnpm check` passes in WSL (lint, typecheck, unit for all 6 packages); `go test ./...` passes in apps/worker.
- Decisions: TypeScript pinned to 6.x (typescript-eslint does not support 7.0). Tooling deps (turbo, eslint, prettier, lefthook, lint-staged, tsx, typescript-eslint) are not in PLAN §4.2 but F-01 requires them. pnpm `allowBuilds` for esbuild + lefthook.
- Next: F-03.
- Ayush must: nothing.
- Model: S · Sonnet 5.5
