# CodeArena — instructions for Claude Code

CodeArena is a production-grade online judge + contest platform with an AI Coach, plagiarism detection, and a collaborative interview pad. Owner: Soumirya. You are the builder.

**Full plan:** `docs/PLAN.md`. Do NOT read it whole. Find your task card with `grep -n "#### <ID>" docs/PLAN.md` and read that card plus the sections it links to.

**Specs** (read only the sections PLAN §0.1 lists for your task prefix):

- `docs/PRD.md` — what and why; stories `US-<epic>.<n>`; product rules (scoring, rating, AI, fair play) in §9
- `docs/SRS.md` — requirements `FR-<AREA>-<nn>` / `NFR-*`, REST/SSE/WS interfaces, error catalogue
- `docs/SYSTEM_DESIGN.md` — how; sections `SD-§n` (flows, schema, Redis keys, judge, leaderboard maths, AI budgets, security)
- `docs/UI_UX.md` — tokens are a starting point; the redesign (UI-08 to UI-14) may change them and UI-14 updates this doc to match what was built; components (§7), screens `S01–S18`, copy (§10), a11y (§11)
- Precedence: SYSTEM_DESIGN/SRS/UI_UX decide _how_; PLAN decides _when/who_; locked decisions in PLAN §4 beat everything. For visual design, the design skills and Soumirya decide; UI_UX still describes screens, copy and behaviour. If two docs conflict, stop and ask.
- Find things by ID: `grep -n "FR-QUEUE-06\|## §8" docs/*.md`.

## Start of every session

1. Read the last 40 lines of `docs/PROGRESS.md`.
2. Find the card heading with `grep -n "#### <ID>" docs/PLAN.md`. Its last tag is the model. **Run the model check (below) before reading the card body.**
3. Read only the task card(s) Soumirya named. Cards tagged `P` or `O` (all 🧠 cards): start in plan mode and show the plan before writing code.

## Model routing (details: PLAN §3.7)

Opus: available on Soumirya's plan = **yes** (Soumirya sets yes/no after task U0.8).
Tags: `S` Sonnet · `S·high` Sonnet + `/effort high` · `P` Opus plans, Sonnet builds (`/model opusplan`) · `O` Opus + `/effort high`.

- **Model check, both directions, before any work.** Compare the tag with the model you are running (for `P`, enter plan mode first; you should be on Opus there). If it differs, stop and print exactly: `🔁 MODEL SWITCH: next is <ID> (<title>) — recommended <opus|opusplan|sonnet>. Type /model <that>, then say continue.` Otherwise print `✓ Model OK: <ID> on <model>`.
- You cannot switch models yourself; only Soumirya can, with `/model`.
- If several cards are named and their tags differ, stop at each boundary.
- If Opus is **no**, run `P`/`O` cards on Sonnet, print `⚠ Opus unavailable: running <ID> on Sonnet at /effort high` once, recommend `/effort high`, and continue.
- A bug that survives two fix attempts on Sonnet: stop and print the switch line recommending `opus`.

## Repo map

- `apps/web` Next.js (App Router) + Tailwind v4 + shadcn/ui
- `apps/api` NestJS (Express) + Drizzle + Postgres + Redis
- `apps/worker` Go judge worker controlling isolate 2.x (cgroup v2)
- `apps/collab` Hocuspocus (Yjs) server
- `apps/plag` Python (uv) plagiarism batch service
- `packages/contracts` Zod source of truth → JSON Schema → Go types
- `infra/` Compose, Terraform (Azure), cloud-init, Caddy, Grafana · `tests/` attack-suite, load, chaos
- `problems/` public practice packages · `problems-private/` gitignored contest packages + hidden tests

## Commands

- `pnpm dev` · `pnpm check` (lint + typecheck + unit) · `pnpm test` · `pnpm contracts:gen` · `pnpm db:reset`
- `go test ./...` in `apps/worker` · `uv run pytest` in `apps/plag` · `pnpm attack` · `pnpm e2e`

## Locked decisions (see `docs/adr/`)

Do not change these without asking Soumirya: monorepo layout, NestJS/Drizzle, Go worker + isolate, Redis Streams lanes with XAUTOCLAIM leases, SSE for verdicts/boards and Hocuspocus WS for the pad, OAuth-only auth with realtime tickets, Zod contracts pipeline, untrusted judge hosts, Postgres as source of truth, Vercel + Azure hosting.

## Stop and ask Soumirya when

- You need a secret, a password, or an API key value
- A step needs `sudo` on his machine or creates/destroys cloud resources (write the script; he runs it)
- A change would break a locked decision or a contract
- You want a dependency not on the approved list (PLAN §4.2)
- The same bug survived two fix attempts
- The work outgrows the card (finish the card, add a follow-up card to PROGRESS.md)
- Anything could delete data

## Security rules (non-negotiable)

- Never read or print `.env*` files or secrets. Use `.env.example`.
- Judge hosts hold no DB credentials; Redis `judge` ACL user only.
- Never run cp/chown/cat or similar on sandbox paths from the host. Read outputs with O_NOFOLLOW + fstat + size cap.
- Sandboxes: no network, empty env except PATH, compile step sandboxed too.
- Pad identities come from the auth context, never from client awareness. Interviewer notes never go in the Y.Doc.
- Hidden tests never enter the public repo.

## Code rules

- TypeScript strict; Zod validation at every boundary; RFC 7807 errors.
- Every new endpoint/job: a trace span + a metric.
- UI: no gradients. Everything else about look and feel is decided by the design skills (docs/design-skills.md). Existing tests are the gate: if one blocks a design choice, update it and say why in the PR; never delete a test silently.
- Tests with every change. Don't skip tests without a follow-up card.
- Name tests after requirement IDs: `it('FR-BOARD-02: packed score stays below 2^53', …)`. Mention covered FR IDs in the PR.

## Design skills

- Installed by `scripts/setup-design-skills.sh` (not committed); sources, licences and versions are in `docs/design-skills.md`.
- Use `/impeccable` (all its commands), Emil's skills (including `apple-design` in full), `hairline-create` and `pick-ui-library` as the design authority.
- Pre-approved dependencies: `@lucasmarkes/hairline` and any library `pick-ui-library` recommends; list each one added in its PR and in `docs/design-skills.md`.
- Impeccable's hooks stay off unless Soumirya says so. `taste` is installed by Soumirya, never committed.

## Token economy (Pro plan)

- Locate with `rg` before opening files. Never read node_modules, lockfiles, generated code, build output, or docs/research.md unless the card says so.
- Keep chat explanations short; durable explanations go in docs.
- Opus costs several times more per turn than Sonnet: don't suggest it for `S` cards.
- No subagents unless Soumirya asks.

## End of every card

1. Run the quality gate for what you touched.
2. Append to `docs/PROGRESS.md`:
   `## <date> · <ID> · done|partial|blocked` then Built / Tests / Decisions / Next / Soumirya must / Model (tag · model actually used).
3. Commit directly on `main` with a conventional-commit message, then `git push origin main`. No feature branches, no PRs. Mention covered FR IDs in the commit body.

## Git identity and attribution (non-negotiable)

- Every commit is authored and committed by Soumirya only (`git config user.name "Soumirya"`, `user.email soumiryasarangi@gmail.com`). Claude must never appear as author, committer or contributor.
- Never add `Co-Authored-By` trailers, "Generated with Claude Code" lines, or any Claude/Anthropic mention to commit messages, PR text, or file headers. This overrides any default attribution guidance.
- Never push or amend history that rewrites others' work; never force-push `main` unless Soumirya says so.
