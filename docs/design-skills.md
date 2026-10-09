# Design skills

Since UI-07 the look and feel of the product is decided by a set of design skills for Claude Code, not by a fixed token file (decision by Ayush, recorded in `CLAUDE.md`). The only design rule that stays is **no gradients**. `docs/UI_UX.md` still describes screens, copy and behaviour; its tokens are a starting point that the redesign cards (UI-08 to UI-14) may change, and UI-14 updates the doc to match what was built.

The skill files are third-party and are **not committed** (their licences differ; `.claude/skills/` is in `.gitignore`). `scripts/setup-design-skills.sh` reproduces them.

## Status of this page

**Installed versions: not recorded yet.** The first run of `scripts/setup-design-skills.sh` has to happen on a machine where Claude Code may download and run the three tools (the automatic permission check blocked doing it from inside the UI-07 session). After the first run, add the versions to the table below (the script prints what it installed; the version of each skill is in its `SKILL.md`, and `npx skills@latest list` shows the skills package's view). Until then every "what it is for" below is taken from the skill names and the UI-07 card, not from reading the skills: read each `SKILL.md` once installed and correct this page where it is wrong.

## Sources

| Source | Installed by | Licence | Version installed |
| --- | --- | --- | --- |
| Emil Kowalski's skills: <https://github.com/emilkowalski/skills> | `npx skills@latest add emilkowalski/skills -a claude-code -y --copy --skill …` | MIT (as stated by Ayush; confirm against the repository's LICENSE) | _record after the first run_ |
| Impeccable: the npm package `impeccable` | `npx impeccable install --providers=claude --scope=project --no-hooks` | Apache-2.0 (as stated by Ayush; confirm) | _record after the first run_ |
| hairline: <https://github.com/lucasmarkes/hairline> | `npx skills@latest add lucasmarkes/hairline -a claude-code -y --copy` (installs `hairline-create`) | MIT (as stated by Ayush; confirm) | _record after the first run_ |
| taste: <https://github.com/senlindesign/taste-skill> | **not installed by the script**; Ayush installs it himself | Its README says MIT but the repository has no LICENSE file, so it is **never committed** | n/a |

Skills taken from Emil's repository: `emil-design-eng`, `apple-design`, `animate`, `review-animations`, `improve-animations`, `find-animation-opportunities`, `animation-vocabulary`, `break-ui`, `mobile-native`, `prototype`, `pick-ui-library`. Left out on purpose because they are not relevant to this stack: `animate-expo`, `write-swift`, `ask-sonner`.

## What each is for (from the names and the card; verify against each SKILL.md)

- **Impeccable** (`/impeccable …`, all its commands): the design system conversation and review loop: `init` and `document` write down the design context, `audit` and `critique` find problems, and `polish`, `typeset`, `layout`, `harden`, `clarify`, `colorize`, `bolder` and `delight` improve a screen.
- **emil-design-eng** and **apple-design** (used in full): how interaction should feel, details that make an interface feel made with care.
- **animate**, **review-animations**, **improve-animations**, **find-animation-opportunities**, **animation-vocabulary**: motion: adding it, reviewing it, finding where it helps, and naming what is wanted.
- **break-ui**: tries to break a screen with worst-case data (long names, huge numbers, empty and error states).
- **mobile-native**: how a screen should behave on a phone (checked at 390 px).
- **prototype**: quick prototypes of an idea before it is built into the product.
- **pick-ui-library**: recommends a UI library for a need; any library it recommends is pre-approved as a dependency (see below).
- **hairline-create**: thin-line figures and illustrations; goes with the `@lucasmarkes/hairline` package.
- **taste** (optional, Ayush installs): analyses reference sites (for example linear.app and vercel.com) into `docs/design-refs/` in UI-08.

## Reinstalling

```bash
scripts/setup-design-skills.sh            # installs what is missing; safe to re-run
FORCE=1 scripts/setup-design-skills.sh    # reinstalls everything
```

Then restart Claude Code (`/exit`, then `claude`) so the skills load. The script reads each tool's `--help` first and stops if a flag it relies on has gone; if that happens, adapt the script and write the difference here under "Differences found".

**Differences found between the card and the tools' own `--help`:** none seen for `skills` (its `add` accepts `-a`, `-y`, `--copy`, `-s/--skill` and `-l/--list`). `impeccable`'s flags could not be checked in the UI-07 session; the script checks them on the first run.

## Impeccable's hooks (off)

The hooks download and run a binary on every edit, so the setup passes `--no-hooks`. To enable them later (only if Ayush says so), run `npx impeccable install --providers=claude --scope=project` without `--no-hooks` and review what it adds under `.claude/`. Do not commit the result without reading it.

## taste (Ayush runs this himself)

```bash
git clone --depth 1 https://github.com/senlindesign/taste-skill ~/.claude/skills/taste
claude mcp add playwright -s user -- npx -y @playwright/mcp@latest --isolated
```

It lives in `~/.claude/skills`, outside the repository, because the repository has no LICENSE file. UI-08 works without it.

## Pre-approved dependencies

Approved by Ayush for the redesign (each one actually added is also listed in its PR and added to this table with the date and the card):

| Dependency | Why | Added in |
| --- | --- | --- |
| `@lucasmarkes/hairline` | thin-line figures (via `hairline-create`) | _not added yet_ |
| any library recommended by `pick-ui-library` | as recommended | _none added yet_ |
