# CodeArena — UI/UX Specification

| | |
|---|---|
| **Doc** | `docs/UI_UX.md` · v1.0 · 30 Sep 2026 |
| **Supersedes** | PLAN §7 for design details (PLAN §7 remains the summary) |
| **Companion docs** | `PRD.md` · `SRS.md` · `SYSTEM_DESIGN.md` |

> **For Claude Code:** implement tokens exactly as in §5 (`apps/web/app/tokens.css`). Build components from §7 before screens. Screen specs are `S01–S18`. Every UI PR must pass the checklist in §17.

---

## §1. Design principles

| # | Principle | In practice |
|---|---|---|
| 1 | **Calm instrument panel** | Dark-first, dense, hairline borders, no gradients, no glass, no decorative animation |
| 2 | **Colour means something** | Colour only for verdicts, live state, focus, and the single brand accent |
| 3 | **Show the system** | Queue position, per-test progress, journey timeline, connection state always visible |
| 4 | **Keyboard first, mouse friendly** | Every action has a shortcut or is reachable by Tab; ⌘K reaches anything |
| 5 | **Motion explains change** | Animate only state changes (rank moves, test completes); never loop except "judging" pulse |
| 6 | **Honest copy** | Plain words, no blame, always say what to do next |

---

## §2. Users and top tasks

| Persona (PRD §4) | Top tasks | UX success measure |
|---|---|---|
| PE1 Riya | Find a problem, run samples, submit, get a hint | First submission ≤ 2 min for new users (median) |
| PE2 Arjun | Enter contest, submit fast, track standings | Zero "where is my submission?" questions in clarifications |
| PE3 Ayush | Upload + validate problems, run the contest, review plagiarism | Validate a package in ≤ 3 clicks; spot a failing worker ≤ 10 s |
| PE4/PE5 Interview pair | Start a room, code together, replay | Room ready ≤ 30 s; candidate joins with one click |

Overall: SUS ≥ 75 (PRD M6).

---

## §3. Information architecture

### 3.1 Sitemap and routes

| Area | Route | Screen |
|---|---|---|
| Public | `/` | S01 Landing |
| | `/signin` · `/onboarding` | S02 Sign in / onboarding |
| | `/status` | S18 Status / under the hood |
| | `/rules` · `/privacy` | Static pages |
| App | `/home` | S03 Home |
| | `/practice` | S04 Practice list |
| | `/p/[slug]` | S05 Problem workspace |
| | `/s/[id]` | S06 Submission detail |
| | `/contests` | S07 Contests list |
| | `/c/[slug]` | S08 Contest lobby / overview |
| | `/c/[slug]/[label]` | S09 Contest arena (workspace in contest mode) |
| | `/c/[slug]/board` | S10 Scoreboard (+ `?present=1` resolver presenter) |
| | `/c/[slug]/results` | S11 Post-contest |
| | `/u/[handle]` | S12 Profile |
| | `/interview` · `/r/[roomId]` | S13 Interview rooms list / room |
| | `/r/[roomId]/replay` | S14 Playback |
| Admin | `/admin/problems[/id]` | S15 Problem setter |
| | `/admin/contests/[id]/ops` | S16 Contest ops console |
| | `/admin/integrity/[runId]` | S17 Plagiarism review |

### 3.2 Navigation model
- **Left rail** (app areas): Home · Practice · Contests · Interview · Profile · Admin (role-gated). Collapsed to icons < 1280 px; becomes a bottom sheet menu < 768 px.
- **Top bar:** ⌘K palette trigger (search field look), live system dot, contest timer (only inside a contest), theme toggle, avatar menu.
- **Contest context:** inside `/c/[slug]/*` a secondary bar shows problem tabs A–F, Board, Clarifications, and the countdown.

---

## §4. Layout

| Breakpoint | Width | Layout |
|---|---|---|
| `sm` | ≥ 640 | Single column |
| `md` | ≥ 768 | Rail as icons; tables scroll inside containers |
| `lg` | ≥ 1024 | Workspace split view available |
| `xl` | ≥ 1280 | Rail expanded (labels) |
| `2xl` | ≥ 1536 | Content max-width 1440 for reading pages; workspace uses full width |

- Grid: 4 px base; page gutter 16 px (mobile) / 24 px (desktop).
- Reading width: statements and docs max 72ch.
- Sticky elements (top bar 48 px, contest bar 40 px) → set `scroll-padding-top: 96px` so focused elements are never hidden (WCAG 2.4.11).

---

## §5. Visual design system

### 5.1 Colour tokens (contrast-checked; ratios vs `--bg` / `--surface-1`)

```css
:root, [data-theme="dark"] {
  --bg:#0A0B0D; --surface-1:#111317; --surface-2:#171A1F; --surface-3:#1E2228;
  --border:#23272E;          /* decorative hairlines only */
  --border-strong:#2F343C;   /* dividers between regions */
  --border-control:#5A626E;  /* inputs, checkboxes: 3.2:1 on bg (WCAG 1.4.11) */
  --text:#E8EAED;            /* 16.3:1 */
  --text-2:#A1A7B0;          /*  8.1:1 */
  --text-3:#858C97;          /*  5.8:1 — never lighter; old #6B7280 failed (4.1:1) */
  --accent:#8B7FFF;          /*  6.2:1 — old #7C6CFF was 4.8:1 on surface-1 */
  --accent-hover:#9D93FF; --accent-fg:#0A0B0D; /* text on accent 6.2:1 */
  --focus:#A99FFF;
  --v-ac:#22C55E;  --v-wa:#F87171;  --v-tle:#F59E0B; --v-mle:#F472B6;
  --v-re:#F97316;  --v-ce:#94A3B8;  --v-ole:#14B8A6; --v-se:var(--text); --v-pending:var(--accent);
  --danger:#F87171; --warning:#F59E0B; --success:#22C55E; --info:#60A5FA;
}
[data-theme="light"] {
  --bg:#FAFAFB; --surface-1:#FFFFFF; --surface-2:#F4F5F7; --surface-3:#ECEEF1;
  --border:#E3E5E8; --border-strong:#D0D4DA; --border-control:#8A919C; /* 3.1:1 */
  --text:#0F1114; --text-2:#4B5260; --text-3:#636A75;   /* 18.1 / 7.5 / 5.2:1 */
  --accent:#5B4BE0; --accent-hover:#4F3FD6; --accent-fg:#FFFFFF; --focus:#5B4BE0;  /* 5.7:1; white on accent 6.0:1 */
  --v-ac:#15803D; --v-wa:#DC2626; --v-tle:#B45309; --v-mle:#BE185D;
  --v-re:#C2410C; --v-ce:#475569; --v-ole:#0F766E;     /* all ≥ 4.6:1 on bg and surface-1 */
  --danger:#DC2626; --warning:#B45309; --success:#15803D; --info:#2563EB;
}
```

Rules:
- Verdict **text** colours are only used on `--bg` or `--surface-1`/`--surface-2`. Badge background = `color-mix(in srgb, var(--v-x) 14%, transparent)` in the **dark** theme. In the **light** theme the verdict colours are only ~4.6:1 on `--bg`, so a tint would drop the label below 4.5:1 (measured with axe, F-07): light badges have no tint and use a 1 px inset ring in the verdict colour at 40% instead.
- Default theme follows `prefers-color-scheme`; user choice stored in localStorage and applied before paint (no flash).
- Never use colour alone: verdicts always show the two/three-letter label; board cells use ✓ / +n / ?n glyphs.

**Presence colours** (cursors, avatars; 8, assigned by server): `#60A5FA #F472B6 #34D399 #FBBF24 #A78BFA #FB923C #22D3EE #F87171` (dark); light theme uses 600-level equivalents `#2563EB #DB2777 #059669 #D97706 #7C3AED #EA580C #0891B2 #DC2626`. Cursor labels: text `#0A0B0D` on dark palette, `#FFFFFF` on light palette.

**Chart palette:** single series = `--accent`; comparisons add `--text-2`; heatmap = 5 steps of `--accent` at 12/30/50/75/100% over `--surface-2`; colour-blind safe because steps differ in lightness.

### 5.2 Typography

Fonts: **Geist Sans** (UI), **Geist Mono** (code, numbers, timers, verdict labels, handles in tables). `font-variant-numeric: tabular-nums` on every changing number.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `--fs-12` | 12 / 16 | 500 | Meta, table secondary, badges |
| `--fs-13` | 13 / 20 | 400 | Dense tables, console |
| `--fs-14` | 14 / 20 | 400 | App body (default) |
| `--fs-16` | 16 / 27 (1.7) | 400 | Problem statements, docs |
| `--fs-20` | 20 / 28 | 600 | Section titles |
| `--fs-24` | 24 / 32 | 600 | Page titles |
| `--fs-32` | 32 / 40 | 600 | Countdown, big numbers |
| `--fs-48` | 48 / 52 | 600 | Landing hero, lobby countdown |

Letter-spacing −0.01em for ≥ 20 px. Uppercase only for 11–12 px micro-labels with +0.04em tracking.

### 5.3 Spacing, radii, borders, elevation

- Spacing scale: 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Radii: `--radius-sm 4px` (badges, cells) · `--radius 6px` (buttons, inputs, cards) · `--radius-lg 10px` (dialogs, panels).
- Borders: 1 px. Elevation is expressed by surface steps (`surface-1 → 2 → 3`); only dialogs and popovers get a shadow: `0 8px 24px rgb(0 0 0 / .35)` (dark) / `rgb(15 17 20 / .12)` (light).

### 5.4 Iconography
lucide, 16 px (20 px in empty states), stroke 1.5, `currentColor`. Icon-only buttons need `aria-label` and a tooltip.

### 5.5 Brand
Wordmark `codearena` in Geist Mono 600 + accent caret `▍`. The caret blinks (1 s steps) only on the landing hero; static elsewhere; static under reduced motion. Favicon: caret on `--bg`.

---

## §6. Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120 ms | Hover, press, toggles |
| `--dur-base` | 180 ms | Panels, tabs, toasts |
| `--dur-slow` | 350 ms | Leaderboard row moves (spring: stiffness 500, damping 40) |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Default |

What animates: verdict grid square fill (scale 0.8→1, 120 ms) · leaderboard FLIP reorder · first-solve cell flash (single 600 ms background pulse) · resolver reveal (cell flip 250 ms) · judging pulse (opacity 0.5↔1, 1.2 s, only while judging) · toasts slide 8 px.
`prefers-reduced-motion: reduce` → all transforms off, reorders are instant, pulse replaced by a static "judging…" label.

---

## §7. Component catalogue

Build with shadcn/ui primitives (Radix) restyled to tokens. Every component documents: anatomy, variants, states (default, hover, active, focus-visible, disabled, loading, error), keyboard behaviour, ARIA.

| Component | Key specs |
|---|---|
| **Button** | Variants: primary (accent bg, accent-fg), secondary (surface-2, border-control), ghost, danger. Sizes 28/32/40 px height (min target 24×24 always met). Loading replaces label with spinner + keeps width. |
| **IconButton** | 28 px square; tooltip on hover/focus after 400 ms; `aria-label` required. |
| **Input / Textarea / Select** | 32 px; `--border-control`; focus ring 2 px `--focus` + 2 px offset; error text below in `--danger` with icon; `aria-invalid`, `aria-describedby`. |
| **Kbd** | Mono 12 px, surface-3, 1 px border; used in tooltips and shortcut sheet. |
| **Tabs** | Underline style (2 px accent); arrow keys move focus; `role=tablist`. |
| **DataTable** | Dense 36 px rows; sticky header; sortable headers with `aria-sort`; row hover surface-2; keyboard row navigation (↑↓, Enter opens); virtualised > 200 rows. |
| **VerdictBadge** | Mono 12 px label (AC/WA/…) + optional "on test 7"; tinted bg; `title` has full name; pending variant pulses. |
| **VerdictGrid** | One 12×12 px square per test (gap 3 px, wraps); states: pending (surface-3 outline), running (accent pulse), verdict colour; hover/focus → tooltip "Test 7 · WA · 31 ms · 2.1 MB"; the whole grid has `role=list`; a visually hidden live region announces "Test 7 wrong answer" only for the final verdict (not every test, to avoid noise). |
| **QueueStatus** | "#4 in queue · ETA ~6 s" mono; updates ≤ 2 s; switches to "Judging on judge-2 · 7/30". |
| **JourneyTimeline** | Vertical list; each step: dot, label, relative time "+1.8 s", absolute on hover; admin sees "View trace ↗". |
| **Timer / Countdown** | Mono tabular; formats `HH:MM:SS`; last 5 min `--warning`; last 60 s `--danger`; `aria-live=off` (announcements only at 15, 5, 1 min via a polite live region). |
| **ConnectionPill** | Hidden when connected ≥ 2 s; "Reconnecting…" (warning) / "Offline" (danger) / "Reconnected" (success, auto-hides 2 s). |
| **Toast** | sonner; max 3; 5 s; for clarifications/announcements persists until dismissed; `role=status`. |
| **Dialog / Drawer** | Focus trapped, Esc closes, returns focus to trigger; drawer 420 px right side (clarifications, shortcut sheet). |
| **CommandPalette** | cmdk; groups: Problems, Contests, Submissions, Actions, Navigation; fuzzy; recent items; opens with ⌘K / Ctrl+K. |
| **Markdown** | react-markdown + remark-math + rehype-katex + rehype-sanitize; code blocks with copy; headings get anchors. |
| **CodeEditor** | Monaco wrapper; lazy; theme from tokens (§14); font Geist Mono 14 px; minimap off; line numbers on; bracket pair colours off; word wrap off; custom keybindings (§13). |
| **DiffViewer** | Monaco diff editor, read-only, side-by-side ≥ 1024 px else inline. |
| **ScoreboardTable** | See S10; row = rank, handle, solved, penalty, cells; sticky rank/handle columns; `role=table` semantics preserved while animating. |
| **ScoreCell** | ✓ mm (AC, success tint), ✓ mm ★ (first solve), +n (rejected attempts, danger text), ?n (pending, accent outline), empty. Text + glyph always. |
| **HintLadder** | 3 stacked cards; locked ones show cost "−10% points"; unlock button requires confirm; content Markdown; helpful 👍/👎 buttons with labels. |
| **PresenceAvatars** | Up to 4 circles 24 px with presence colour ring; role icon; overflow "+2". |
| **RemoteCursor** | 2 px caret in presence colour + name flag (12 px) that fades to 40% after 2 s idle. |
| **PlaybackScrubber** | Track with event markers (▲ run, ● verdict, ◆ language, ○ join/leave); keyboard: ←/→ 5 s, Shift+←/→ 30 s, Home/End, Space play/pause; `role=slider` with `aria-valuetext="12:40 of 45:00"`. |
| **StatTile** | Label (12 px, text-3) + value (24 px mono) + optional delta; used on landing, ops, status. |
| **Heatmap** | 53×7 squares 11 px; tooltip "3 submissions on 4 Oct"; table fallback for screen readers. |
| **RatingChart** | Recharts line, accent, points with tooltip (contest, rank, delta); axes text-3. |
| **ClusterGraph** | Force-directed (small), nodes = users, edge thickness = score; table view toggle (default for keyboard/screen reader users). |
| **EmptyState / ErrorState / Skeleton** | Empty: icon + one line + one action. Error: what happened + retry + request ID. Skeleton matches final layout (no layout shift). |

---

## §8. Screen specifications

Each screen lists: purpose · layout · content · interactions · states · responsive · accessibility · events (PRD §11).

### S01 Landing (`/`)
- **Purpose:** explain CodeArena in 5 seconds; prove it's real.
- **Layout:** hero (wordmark, one-line pitch "Practise, compete, and interview — on a judge you can trust.", primary CTA "Start practising", secondary "Upcoming contest →"); **live stats row** (submissions judged, contests hosted, p95 verdict time — from `/api/status`); **live verdict ticker** (last 10 anonymised verdicts: "C++ · B · AC · 41 ms", no handles); four feature sections (Practice · Contests · Interview pad · Under the hood) each with a small static product screenshot; footer (rules, privacy, status, GitHub).
- **States:** stats unavailable → hide the row (never show zeros as if real).
- **Responsive:** stacks; ticker becomes 3 items.
- **A11y:** ticker is `aria-hidden` with a "Pause ticker" control; screenshots have alt text.

### S02 Sign in / onboarding (`/signin`, `/onboarding`)
- Sign in: two buttons "Continue with Google", "Continue with GitHub"; one line on what we store (link to privacy).
- Onboarding (first login): handle field with live availability + rules text; default language select; "Let's go" → `/practice`.
- Errors: OAuth cancelled → "Sign-in was cancelled. Try again?"; handle taken → suggestion `riya_k2`.
- A11y: no CAPTCHA or cognitive test (WCAG 3.3.8); paste allowed everywhere.

### S03 Home (`/home`)
- Cards: next contest (countdown + register), continue practising (last 3 attempted), recent submissions (5), activity heatmap (compact), hints used this week.
- Empty (new user): "Start with these 5 warm-up problems" list.

### S04 Practice list (`/practice`)
- Filter bar: search, difficulty range (two selects, not a drag slider), tags (multi-select combobox), status (all/solved/attempted/new). All mirrored in URL.
- DataTable columns: status icon (✓ / • / —, with `aria-label`), title, difficulty (label + number), tags (max 3 + "+n"), acceptance %.
- Keyboard: `/` focuses search; ↑↓ rows; Enter opens.
- Empty filter result: "No problems match. Clear filters".

### S05 Problem workspace (`/p/[slug]`)
- **Layout ≥ 1024 px:** resizable split (default 40/60) — left: header (label, title, limits, checker description, tags), statement, samples (copy / "Run this sample"), Hints entry (practice only); right: editor toolbar (language select, reset, font size, Run ⌃↵, Submit ⌃⇧↵), Monaco, bottom drawer (default 35% height) with tabs **Console · Tests · Submissions · Coach**.
- **Console:** input textarea (custom), stdout/stderr blocks, time/memory, sample diff (expected vs yours, line-level).
- **Tests tab:** latest submission's VerdictGrid + QueueStatus + verdict header + link "Details →".
- **Submissions tab:** my submissions for this problem (table).
- **Coach tab:** HintLadder (S05 only, disabled in contests with message "Hints are off during contests — they'll be back after it ends.").
- **Interactions:** Submit shows an optimistic row immediately; verdict arrives via SSE; drafts autosave to localStorage per problem+language (debounce 500 ms); resize via drag or keyboard (divider focusable, ←/→ 5%).
- **States:** Monaco loading skeleton; SSE reconnecting pill; submit rate-limited → inline "You can submit again in 8 s" countdown on the button.
- **< 1024 px:** tabs Statement / Code / Console; Submit button fixed at the bottom.
- **A11y:** editor has label "Code editor, C++"; Monaco tab-trap toggle hint shown in shortcut sheet; final verdict announced politely.
- **Events:** `problem_opened`, `code_run`, `submission_created`, `verdict_viewed`.

### S06 Submission detail (`/s/[id]`)
- Header: VerdictBadge (large), problem link, language, time, memory, submitted at; "Resubmit in editor" button.
- Two columns: left JourneyTimeline + per-test table (test no, verdict, time, memory; first failing highlighted); right read-only code (Monaco) + compile log (CE).
- Admin extras: worker ID, run versions list, "Rejudge", trace link.
- Privacy: other users see 404 (not 403) for private submissions.

### S07 Contests list (`/contests`)
- Sections: Running now (prominent, "Enter"), Upcoming (start in IST + local, duration, registered count, Register), Past (results link).

### S08 Contest lobby / overview (`/c/[slug]`)
- Before start: big countdown (48 px mono), rules summary (scoring, freeze, language multipliers, fair play — link to full rules), problem count, registered count, Register/Registered state, "Add to calendar" (.ics).
- At start: transitions to arena automatically (no reload); a polite live announcement "Contest started".
- After end: links to Board and Results.

### S09 Contest arena (`/c/[slug]/[label]`)
- Contest bar: problem tabs A–F (state glyph + solve count "12✓"), Board, Clarifications (badge with unread), countdown.
- Body: S05 workspace in contest mode (no Coach; "My submissions" instead of practice history).
- Freeze banner (top, accent outline): "Standings are frozen for the last 30 minutes. You still see your own results."
- Clarification drawer: list (mine + public), ask form (problem select + question), answers highlighted when new.
- Last 5 minutes: timer turns warning; last minute: danger; at end: modal "Contest over. Final results after the reveal." with link to Board.

### S10 Scoreboard (`/c/[slug]/board`)
- Header: contest title, state chip (Live / Frozen / Final / Resolving), "Jump to me", filter (friends later — out of scope), presenter toggle (admin).
- Table: rank (shared ranks shown as "3"), handle (mono, rating colour-neutral), solved, penalty, cells A–F (ScoreCell), header shows problem label + solves count.
- Motion: rows glide on rank change (350 ms spring); first-solve cell flashes once.
- Resolver (admin, `?present=1`): full-screen, larger type (+2 steps), Space = next step, A = auto (1 step/1.2 s), Esc = exit; current row highlighted; step counter "Revealing 23/61".
- Performance: virtualised; diffs patched in place; no full re-render per event.
- A11y: real `<table>`; rank changes announced only for the viewer's own row ("You moved to rank 7").

### S11 Post-contest (`/c/[slug]/results`)
- Final standings (static board), my summary card (rank, solved, penalty, rating change with arrow and number), per-problem cards with my final verdict, AI review (status: ready / generating / queued), editorial link, "Upsolve" button.
- AI review layout: sections Complexity · Edge cases you missed · Compared with the intended approach · Readability; "Was this useful?" buttons.

### S12 Profile (`/u/[handle]`)
- Header: avatar, handle, rating (number + tier word, no colour-only tiers), joined date.
- Rating chart, heatmap, solved by difficulty (bar list), solved by tag (top 10 list), contest history table.
- Own profile: settings link (default language, theme, sign out everywhere, delete account).

### S13 Interview (`/interview`, `/r/[roomId]`)
- **List:** "New room" (problem search or blank, language, duration), my rooms (open/closed, date, role, "Replay").
- **Room layout ≥ 1024 px:** top bar (room name, timer, PresenceAvatars with roles, connection pill, Copy invite ▾ candidate/observer, End room); main: editor (Monaco + y-monaco) with tabs **Code · Whiteboard · Notes 🔒** (Notes only for interviewer); right or bottom: problem statement (collapsible) and shared Output panel (Run history with who ran it).
- **Interactions:** language select syncs to all; Run/Submit buttons disabled for observers; a small "Candidate is typing" indicator via awareness; End room confirms and redirects the interviewer to playback.
- **Observers:** banner "You're observing — read-only".
- **States:** joining (skeleton), reconnecting (pill + editor stays editable offline if CP-09 on), room closed ("This room has ended").
- **< 1024 px:** tabs Code / Output / Problem; whiteboard hidden on phones.

### S14 Playback (`/r/[roomId]/replay`)
- Read-only editor, PlaybackScrubber, speed (1×/2×/4×), event list (clickable, jumps), notes side panel (interviewer), AI summary (P2), "Restore this version into a new room" (optional).
- Seek < 1 s; loading indicator only if > 300 ms.

### S15 Admin · Problem setter (`/admin/problems/[id]`)
- Tabs: Overview (metadata, versions list) · Statement (split editor: Markdown left, rendered preview right) · Tests (table: no, size, sample flag, download) · Solutions & Validation (table: solution, language, expected, actual, time, ✓/✗; "Validate" button; last run status) · Hints (editorial key ideas, avoid-sets per level).
- Upload: drag-and-drop zone **plus** "Choose file" button (WCAG 2.5.7); import errors listed with file paths.
- *As built (UI-04):* routes are `/admin/problems` (list + upload) and `/admin/problems/[slug]` (the slug stands in for `[id]`: unique and readable). The upload takes a **package folder** (drag it on, or "Choose folder", the single-pointer alternative); only the package's own files are sent and the page says how many others were left behind. The Statement tab is Monaco Markdown beside the same sanitised renderer the problem page uses; "Save as a new version" creates a version with the same tests and validation state. The Tests tab downloads files with the bearer token (no cookie links). Validation shows expected against actual for every package solution and the validator, polls every 1.5 s, and lists what differs (failing tests with the checker's or validator's message, compile logs). Hints holds the editorial; per-level avoid-sets are not stored anywhere yet and arrive with the AI Coach. The Admin entry in the rail appears for setters and admins only; the API enforces the role on every call.

### S16 Admin · Contest ops (`/admin/contests/[id]/ops`)
- Top row StatTiles: submissions/min, queue depth (per lane mini bars), p50/p95 time-to-verdict, active workers, DLQ count (danger if > 0).
- Workers table: id, status (idle/busy/unhealthy), current job, heartbeat age (turns danger > 10 s), calibration ms.
- Actions: Extend (+5/+10/+15), Announce, Hide problem, Rejudge (dialog with scope), Rebuild board, Open resolver.
- Clarifications inbox: unanswered first; answer box with "Public" toggle; keyboard `j/k` to move, `r` to reply.
- Live Grafana link.

### S17 Admin · Plagiarism review (`/admin/integrity/[runId]`)
- Left: clusters list (problem, size, max score, status). Center: selected cluster → member list + pair table (fp score, embedding score, combined). Right/bottom: DiffViewer toggle Original / Normalised with matched regions highlighted; Advisory signals card ("advisory only" label, paste events, time-to-AC).
- Decision bar: Clear · Confirm · Needs discussion + required note; audit trail below.
- Copy: never says "cheater"; uses "similar submissions", "reviewed".

### S18 Status / under the hood (`/status`)
- Health rows (API, Judges, Realtime, Interview pad) with state words + icons; live queue depth and p95; "Security: 25/25 sandbox attacks blocked (last run 02:10 today)"; load-test table from METRICS; architecture diagram (SVG from SD-§3.2); "How judging works" 5-step explainer.

---

## §9. Key flows (with error branches)

**F1 First submission:** Landing → Start practising → Sign in (Google) → Onboarding (handle) → Practice list (warm-up filter preset) → Problem → Run sample → Submit → VerdictGrid → AC toast "Solved! Next: …".
- Branch: WA → "Wrong answer on test 3" + "Get a hint" (practice) + "Compare with sample output" if sample failed.
- Branch: CE → Console opens with compiler output; clicking a line number jumps in the editor.

**F2 Contest:** Contests → Register → Lobby countdown → auto-open arena → submit → board → freeze banner → end modal → resolver (watch) → Results → review.
- Branch: SSE drops → pill "Reconnecting…" → replay → pill "Reconnected".
- Branch: rate-limited submit → button countdown.

**F3 Setter:** New problem → upload package → import errors? (fix, re-upload) → Validate → all ✓ → add to contest.

**F4 Interview:** New room → copy candidate invite → candidate opens link → signs in if needed → joins → code/run → interviewer notes → End → playback.

---

## §10. Content design

### 10.1 Voice and tone
Plain, calm, specific. Second person. No blame, no jokes in errors, no exclamation marks except "Solved!". Numbers over adjectives ("#4 in queue", not "a short wait").

### 10.2 Verdict copy
See SRS Appendix A. Detail line pattern: `<Verdict name> on test <n>` + `time · memory`. SE: "System error — not your fault. The organisers have been alerted and it will be rejudged."

### 10.3 Error messages (pattern: what happened + what to do)

| Situation | Message |
|---|---|
| Rate-limited submit | "You're submitting quickly. You can submit again in 8 s." |
| Source too large | "Your code is over 64 KB. Remove unused code and try again." |
| Contest not started | "This contest starts at 7:00 PM IST. Problems unlock then." |
| Hints in contest | "Hints are off during contests — they'll be back after it ends." |
| AI busy | "Hints are busy right now. Try again in a minute." |
| Offline | "You're offline. Your code is saved on this device." |
| Room closed | "This interview room has ended." |
| Generic | "Something went wrong on our side. Try again. (Ref: 7f3a…)" |

### 10.4 Empty states

| Where | Copy + action |
|---|---|
| No submissions | "No submissions yet. Pick a warm-up problem to start." → Practice |
| No contests upcoming | "No contests scheduled. Practise meanwhile." |
| No clarifications | "No clarifications yet. Ask if something in a statement is unclear." |
| No rooms | "No interview rooms. Create one and share the invite link." |

### 10.5 Formatting
- Time: IST by default with local time in tooltip when different; relative for < 24 h ("3 min ago"); contest times always absolute.
- Durations: `1:52:07`; test time `41 ms`; memory `2.1 MB`.
- Numbers: tabular, thin space thousands not used (use `1,204`).

### 10.6 Terminology (use exactly)
Run (not "test" or "execute") · Submit · Verdict · Test (never "test case" in UI) · Standings/Board (use "Board" in nav, "Standings" in headings) · Hint · Review · Room · Replay · Clarification · Announcement.

---

## §11. Accessibility (WCAG 2.2 AA)

| Criterion | How CodeArena meets it |
|---|---|
| 1.1.1 Non-text content | Icon buttons labelled; charts have table fallbacks; screenshots alt text |
| 1.3.1 Info and relationships | Real `<table>` for board/lists; headings hierarchy; form labels |
| 1.4.1 Use of colour | Verdict labels + board glyphs; state words next to status dots |
| 1.4.3 / 1.4.11 Contrast | Token ratios in §5.1 (text ≥ 4.5:1, controls/focus ≥ 3:1) |
| 1.4.10 Reflow | All non-editor pages work at 320 px width without horizontal scroll (tables scroll inside containers) |
| 2.1.1 Keyboard | Everything reachable; Monaco tab trap toggle documented (Monaco's "Tab moves focus" toggle, Ctrl+M) |
| 2.2.1 Timing adjustable | Contest timers are essential (exception); session expiry warns 2 min ahead in rooms |
| 2.3.3 / reduced motion | §6 |
| 2.4.3 Focus order | Logical DOM order; dialogs trap and restore focus |
| 2.4.7 / 2.4.11 Focus visible, not obscured | 2 px `--focus` ring with offset; `scroll-padding-top` for sticky bars |
| 2.5.7 Dragging movements | Resizable panels via keyboard/buttons; scrubber via keys and click; upload via button; whiteboard move via arrow keys |
| 2.5.8 Target size (minimum) | Controls ≥ 24×24 px; board cells 40×32 px |
| 3.2.6 Consistent help | "Rules" and "Status" links in the same footer position everywhere |
| 3.3.1 / 3.3.3 Errors | Inline, specific, with suggestions |
| 3.3.7 Redundant entry | Language preference and handle prefilled everywhere |
| 3.3.8 Accessible authentication | OAuth only; no CAPTCHA; paste allowed |
| 4.1.3 Status messages | Polite live regions for final verdicts, contest start/end, clarification answers, own rank change |

Testing: axe-core in Playwright on every screen (0 serious/critical), manual keyboard pass per screen, NVDA spot check on S05 and S10 before Day 10.

---

## §12. Responsive rules
- ≥ 1024 px: full workspace, board, ops, pad.
- 768–1023 px: workspace tabs; board scrolls horizontally within its container with sticky rank/handle.
- < 768 px: practice, statements, board viewing, profiles, status fully supported; coding is possible but not optimised; pad whiteboard hidden.
- Touch: targets ≥ 32 px on touch devices (`@media (pointer: coarse)`).

---

## §13. Keyboard shortcuts

| Shortcut | Action | Scope |
|---|---|---|
| ⌘K / Ctrl+K | Command palette | Global |
| ? | Shortcut sheet | Global (not in inputs) |
| g p · g c · g i · g h | Go to Practice / Contests / Interview / Home | Global |
| / | Focus search | Lists |
| Ctrl+Enter | Run | Workspace, room (overrides Monaco's default via `addCommand`) |
| Ctrl+Shift+Enter | Submit | Workspace, room |
| Alt+1..4 | Console / Tests / Submissions / Coach tabs | Workspace |
| Alt+A … Alt+F | Switch contest problem | Arena |
| b | Open board | Arena |
| j / k / r | Next / previous / reply | Ops clarifications |
| Space, A, Esc | Next step / auto / exit | Resolver |
| Space, ←/→, Shift+←/→ | Play/pause, ±5 s, ±30 s | Playback |

macOS shows ⌘ where Ctrl is listed.

---

## §14. Monaco theme (from tokens)

| Token | Dark | Light |
|---|---|---|
| editor.background | `#0A0B0D` | `#FFFFFF` |
| editor.foreground | `#E8EAED` | `#0F1114` |
| lineNumber / active | `#858C97` / `#E8EAED` | `#636A75` / `#0F1114` |
| selection | accent 28% | accent 18% |
| keyword | `#B4A9FF` | `#4F3FD6` |
| string | `#86EFAC` | `#15803D` |
| number | `#FBBF24` | `#B45309` |
| comment | `#858C97` italic | `#636A75` italic |
| function | `#93C5FD` | `#1D4ED8` |
| type | `#67E8F9` | `#0E7490` |

Remote selection colours come from presence colours at 25% opacity.

---

## §15. Performance UX budgets
- Core Web Vitals per SRS NFR-PERF-07; Monaco loaded after first paint of the statement.
- Skeletons for any content taking > 150 ms; spinners only inside buttons.
- Optimistic UI for submit, register, clarification send, hint feedback.
- SSE-driven views never poll.

---

## §16. Usability test plan (before Day 7 dry run)

- **Participants:** 5 classmates (2 new to competitive programming).
- **Tasks:** (1) sign up and solve the easiest problem; (2) find why a submission failed; (3) get a hint; (4) register for the contest and find its start time; (5) during a 10-minute mini contest, check your rank.
- **Measures:** task success, time on task, errors, SEQ (single ease question 1–7) per task, SUS at the end.
- **Output:** issues ranked by severity → GitHub issues labelled `ux` → fixed before Day 9 code freeze.

---

## §17. Design QA checklist (every UI PR)

- [ ] Uses tokens only (no hex in components); both themes checked
- [ ] All states: loading (skeleton), empty, error (with retry + ref), offline/reconnecting
- [ ] Keyboard-only walkthrough done; focus visible and never hidden
- [ ] axe-core: 0 serious/critical
- [ ] Reduced motion respected
- [ ] 1280 px and 390 px screenshots attached to the PR
- [ ] Copy follows §10 (terminology, error pattern)
- [ ] Numbers tabular; times formatted per §10.5
- [ ] No layout shift when data arrives
