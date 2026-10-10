# Design skills

Since UI-07 the look and feel of the product is decided by a set of design skills for Claude Code, not by a fixed token file (decision by Ayush, recorded in `CLAUDE.md`). The only design rule that stays is **no gradients**. `docs/UI_UX.md` still describes screens, copy and behaviour; its tokens are a starting point that the redesign cards (UI-08 to UI-14) may change, and UI-14 updates the doc to match what was built.

The skill files are third-party and are **not committed** (their licences differ; `.claude/skills/` is in `.gitignore`). `scripts/setup-design-skills.sh` reproduces them.

## Installed on 2026-10-09

`scripts/setup-design-skills.sh` ran on Ayush's machine and its own check passed for all 13 skills. Versions, licences and repositories were checked against the registries (GitHub API for the skills repositories, npm for Impeccable), not taken from memory.

| Source | Licence (checked) | Version installed |
| --- | --- | --- |
| Emil Kowalski's skills: <https://github.com/emilkowalski/skills> | MIT | no release numbers: `main` at commit `e8a175de22` (2026-10-02); exact file hashes are in `skills-lock.json` |
| Impeccable: <https://github.com/pbakaus/impeccable>, npm package `impeccable`, <https://impeccable.style> | Apache-2.0 | **4.5.2** (npm and the skill's own `version`) |
| hairline: <https://github.com/lucasmarkes/hairline> | MIT | no release numbers: `main` at commit `a2217852fe` (2026-10-08); hash in `skills-lock.json` |
| taste: <https://github.com/senlindesign/taste-skill> | **none**: the repository has no LICENSE file (the GitHub API reports no licence), so it is never committed | not installed by the script. Installed by hand on 2026-10-09 into `~/.claude/skills/taste` (outside the repository) at `main` commit `6dce223f2f` (2026-07-07) |

What the installers put on disk: `.claude/skills/<name>/` for all 13 skills (ignored by git); `.claude/agents/impeccable-*.md`, four helper agent definitions that Impeccable installs (`impeccable-asset-producer`, `-documenter`, `-finish-reviewer`, `-manual-edit-applier`; ignored by git; they only run if Impeccable calls them, and `CLAUDE.md` still says no subagents unless Ayush asks); and **`skills-lock.json`** at the repository root (sources and content hashes only, no third-party text, committed so the exact set can be checked or restored with `npx skills@latest experimental_install`). `.claude/settings.json` was not changed: **no hooks were added**.

Both installers warn that skills run with the agent's full permissions. `npx skills` also prints a security assessment per skill: for `hairline-create` it reported "Safe" (Gen), 0 alerts (Socket) and **Medium risk (Snyk)**; read that skill (`.claude/skills/hairline-create/SKILL.md`) before running it on anything important. Impeccable's skill runs its own scripts from `.claude/skills/impeccable/scripts/` (for example `impeccable context` at the start of a session): that is third-party code, so read it once before relying on it.

## What each skill is, from its own description

- **Impeccable** (`/impeccable <command>`, version 4.5.2): for designing, redesigning, critiquing, auditing and polishing a frontend interface. The commands the redesign cards use all exist in this version: `init`, `document`, `audit`, `critique`, `polish`, `typeset`, `layout`, `harden`, `clarify`, `colorize`, `bolder`, `delight` (each has a file in `.claude/skills/impeccable/reference/`). It also has `hooks`, `pin`/`unpin` and `doctor`, and writes project artifacts such as `PRODUCT.md` and `DESIGN.md` and `.impeccable/config*.json`.
- **emil-design-eng**: Emil Kowalski's philosophy on UI polish, component design, animation decisions and the invisible details.
- **apple-design**: Apple's approach to interface design and fluid, physical motion translated for the web (gestures, springs, interruptible transitions, materials and depth, typography, reduced motion, design foundations). Used in full.
- **animate**: builds an animation from scratch, deciding in order whether to animate at all, why, with which tool, properties, curve and duration, how it interrupts and exits; writes the implementation.
- **review-animations**: reviews animation code against a high craft bar; flags by default, approval is earned.
- **improve-animations**: read-only: audits a codebase's motion and writes prioritised implementation plans for other agents.
- **find-animation-opportunities**: read-only: finds places that should animate and rejects those that should not, with exact values; does not implement.
- **animation-vocabulary**: turns a vague description of a motion effect into its exact name.
- **break-ui**: feeds a piece of UI worst-case data (long names, huge counts, empty states, non-Latin text, emoji) and **renders it behind a "Demo data / Worst case" toggle**, then reports what broke and the fix. Note for UI-08, which is read-only: run it on a scratch copy or discard what it adds.
- **mobile-native**: the small CSS and meta-tag fixes that make a web app feel native on a phone (hover states, 100vh, input zoom, pull-to-refresh, safe areas).
- **prototype**: builds several genuinely different versions of a UI piece behind a visual picker. Runs only when invoked explicitly.
- **pick-ui-library**: picks a library for a frontend task from a curated list. Runs only when invoked explicitly. Any library it recommends is pre-approved as a dependency.
- **hairline-create**: draws one isometric line figure in the style of `@lucasmarkes/hairline` and hands it over as a single self-contained HTML file.
- **taste** (optional, outside the repository): analyses reference sites into `docs/design-refs/` in UI-08.

## Reinstalling

```bash
scripts/setup-design-skills.sh            # installs what is missing; safe to re-run
FORCE=1 scripts/setup-design-skills.sh    # reinstalls everything
```

Then restart Claude Code (`/exit`, then `claude`) so the skills load. The script reads each tool's `--help` first and stops if a flag it relies on has gone; if that happens, adapt the script and write the difference here under "Differences found".

**Differences found between the card and the tools' own `--help`:** none. `skills add` accepts `-a`, `-y`, `--copy`, `-s/--skill` and `-l/--list`; `impeccable install` accepts `--providers`, `--scope`, `--no-hooks` (and `-y`, `--force`, `--project`, `--user`). Extra effects the card did not mention: the `.claude/agents/impeccable-*.md` files and `skills-lock.json` described above.

## Impeccable's hooks (off)

The hooks download and run a binary on every edit, so the setup passes `--no-hooks` and `.claude/settings.json` has none. To enable them later (only if Ayush says so), use Impeccable's own command, `/impeccable hooks on` (`/impeccable hooks status` shows the state, `off` reverses it), and review what it adds to `.claude/` before committing anything.

## taste (outside the repository)

```bash
git clone --depth 1 https://github.com/senlindesign/taste-skill ~/.claude/skills/taste
claude mcp add playwright -s user -- npx -y @playwright/mcp@latest --isolated
```

It lives in `~/.claude/skills`, outside the repository, because its repository has no LICENSE file; the second command adds the Playwright MCP server at user level (written to `~/.claude.json`, so it applies to every project on this machine). UI-08 works without it. **Both commands were run on 2026-10-09**: `claude mcp list` shows `playwright: npx -y @playwright/mcp@latest --isolated - ✔ Connected`, and `/taste <url>` is in the skill list. Restart Claude Code once so the MCP tools load in a new session.

## Pre-approved dependencies

Approved by Ayush for the redesign (each one actually added is also listed in its PR and added to this table with the date and the card):

| Dependency | Why | Added in |
| --- | --- | --- |
| `@lucasmarkes/hairline` | thin-line figures (via `hairline-create`) | _not added yet_ |
| any library recommended by `pick-ui-library` | as recommended | _none added yet_ |

### `pick-ui-library` verdict at UI-09 (2026-10-10)

Run against the foundation work. Its rule: use a listed library that is already installed; flag a competitor but do not churn it. The project already uses **Sonner** (toasts, listed) and **motion** (listed); it uses **Radix** for dialog, tabs, tooltip and slot, where the list prefers **base-ui**. Verdict: **flag, do not migrate** (no user-visible gain, 8 components and their tests would change); revisit only if a Radix limitation blocks a card. Nothing was added in UI-09.
