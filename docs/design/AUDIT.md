# UI audit (UI-08)

Scope: screens S01 to S18 as they are on `main`, before the redesign. Method: 100 Playwright captures (18 screens × 1280/390 × dark/light, plus tab states) with measured style data per capture (`docs/design/screens/`, `screens/data/`), 12 worst-case captures (`*-worst-*`), the Impeccable detector, an Impeccable critique run as two isolated sub-agents, the audit scoring, a read-only review of the motion code, and a mobile pass on the 390 captures. Reproduce: `DESIGN_SHOTS=1 pnpm --filter web exec playwright test e2e/design-shots.spec.ts --workers=2`.

**Limitations (read these):** every capture uses **stubbed API data** and a fixed clock; real-time behaviour (SSE flashes, rank-change motion, the live pad, loading and error states) is not visible in stills. Performance was assessed from code only, not measured. Two critique findings came from looking at full-page screenshots and need a live check (marked *verify*). Fonts in the headless browser have no CJK or emoji face, so the tofu boxes may be partly an environment effect; the fix (a fallback stack) is cheap either way.

## Scores

| Dimension (Impeccable audit, 0 to 4) | Score | Key finding |
|---|---|---|
| Accessibility | 3 | All token pairs pass (lowest text 4.69:1, UI 3.02:1); focus ring and reduced motion present. 77% of text is ≤12.25 px. |
| Performance | 3 | Code evidence only: Monaco, diff and pad editors are lazy-loaded; no measurement. |
| Theming | 4 | No raw colours outside `tokens.css` and the Monaco theme; 46 of 46 dark/light pairs match in layout. |
| Responsive | 2 | No horizontal overflow on the 100 captures; but 60% of controls on phones are under 32 px, none reach 44 px. |
| Implementation integrity | 3 | Coherent token system (PASS); six off-scale literals, all in SVG or editor internals. |
| **Total** | **15/20** | Good engineering base; the gap is design, not code quality. |

Nielsen heuristics (critique A): **25/40**. Cognitive load: 6 of 8 checklist items fail. Design-specificity verdict: the look could belong to any developer tool.

## Findings, ranked

Owner cards: UI-09 foundation (tokens, fonts, base components, shell) · UI-10 S01 to S04 · UI-11 S05 to S06 · UI-12 S07 to S12 · UI-13 S13 to S18 · UI-14 docs sync.

| # | Sev | Screen(s) | Finding (evidence) | Fix | Owner |
|---|---|---|---|---|---|
| 1 | **P0** | S01 | Landing is an `h1` on an empty canvas inside the signed-in app shell: no tagline, no action beyond a small button, no proof. It is the only page a reviewer or recruiter sees first. | Own shell without the rail; tagline; one primary action; journey figure; measured proof from `docs/METRICS.md`; link to S18. Only real evidence. | UI-10 |
| 2 | P1 | all, esp. phones | 425 of 703 controls in the 27 dark 390 px captures are under 32 px (25 px icon buttons ×50, wordmark link 70×18, Search 28×25, Sign out 60×25, footer links 14 px high, selects and inputs 28 px). `button.tsx` sizes are 24.5 / 28 / 35 px rendered. | 44 px hit areas under 768 px or coarse pointer (padding or pseudo-element, visuals unchanged); 36 px desktop default. | UI-09 |
| 3 | P1 | all | Text is small and flat: root font 14 px, rendered body 12.25 px, 77% of text ≤12.25 px, 18% at 10.5 px; largest heading is 21 px (1.7× body); only 21% of text is ≥14 px. | New scale (root 16 px; meta floor 12; body 14; display 40 to 72); see DIRECTION.md. | UI-09 |
| 4 | P1 | S08, S09, S10, S11 | Contest day has no peak: the board is a 12 px table with a faint tint on your row and no freeze or last-updated cue; the arena shows nothing about contest state beyond a small timer; results show the rating change (`−7`, 1500 → 1493) in 11 px grey. | Stage density: large rank and countdown, anchored own row, freeze banner, rating change as display numeral with framing copy, next-step action. | UI-12 |
| 5 | P1 | S03, S08, S12, S17 (390) | Worst-case data breaks layout: a 64-character handle causes horizontal overflow on S03, S08, S12 and S17 at 390 px (the h1 "Welcome back, …" runs off screen on S03). | `min-w-0`, truncation with full value on hover/long-press and `overflow-wrap:anywhere` for handles, titles, emails. | S03 UI-10 · S08, S12 UI-12 · S17 UI-13 |
| 6 | P1 | all | CJK, Arabic and emoji render as tofu boxes in handles and titles (S03, S10 worst-case captures). *Partly environment.* | Fallback font stack in the foundation; keep `lang`/`dir` handling in mind. | UI-09 |
| 7 | P2 | S06, S13 pad, S11, S14, S15 | Heading hierarchy is inconsistent: S06 h1 and h2 are both 14 px (ratio 1.0), S13 pad 14 vs 12.25 px, S11 has an h2 and h3 of equal size, S15 statement has two h1s (21 and 17.5 px), S14 h2s jump 12.25 to 14 px. | One h1 per screen; fixed ladder with ratio ≥1.25. | scale UI-09 · S06 UI-11 · S11 UI-12 · S13–S15 UI-13 |
| 8 | P2 | S02, S15, S16 | Primary buttons in muted violet read as disabled ("Let's go", "Save as a new version", "Send announcement"). | Ink-on-paper primary with an unambiguous disabled style. | UI-09 (button) · S02 UI-10 · S15, S16 UI-13 |
| 9 | P2 | shell, S11, S12, S16, S17, S18 | Three shells (app, arena, centred 670 px column on S11 and S18); in full-page captures the rail's background stops near y=800 on long pages (*verify live: may be a capture artefact of a viewport-height sticky rail*). | One shell contract, full-height rail, two content widths (Workbench full, Stage centred 1120). | UI-09 |
| 10 | P2 | S07, S13, S16 | Action hierarchy: violet Register beside ghost Enter (S07); red "End room" beside Copy-link buttons (S13); +5/+10/+15 min, Rejudge…, Rebuild board in one undifferentiated row (S16). | One primary per view; destructive actions separated and confirmed; group by risk. | S07 UI-12 · S13, S16 UI-13 |
| 11 | P2 | S15, S16, S17 | Admin consoles stack everything in one scroll with undefined jargon ("Canary off", "Dead letters", "Lanes"): judge-2 "Unhealthy" is a small red word in a table. | Health banner first; group by risk; define terms inline; progressive disclosure. | UI-13 |
| 12 | P2 | S04, S10, S05, S09, S06 (390) | Phone layouts: S04 table clipped (Acceptance column cut off, titles wrap to 3 lines); S10 shows only column A with a wrapped cell; S05 and S09 sticky Run/Submit bar overlaps the bottom nav and a sample card; S06 test table cells wrap "17 ms" over 2 to 3 lines and 60 tests make a 3264 px page. | Card rows for S04; horizontally scrollable board with sticky handle; reserve space for sticky bar; non-wrapping numeric cells. | S04 UI-10 · S05, S06 UI-11 · S09, S10 UI-12 |
| 13 | P2 | S06, S07, S08 | Mixed date formats: S06 prints `10/6/2026, 10:00:00 AM` (US) while others print `Sat 10 Oct, 05:32 IST · 00:02 UTC`; IST and UTC both shown in long strings. | One date formatter; local time with UTC in a tooltip. | S06 UI-11 · S07, S08 UI-12 |
| 14 | P2 | S01, S02 | App navigation (Home, Practice, Contests, Interview, Profile) is shown to signed-out users and leads to gated pages. | Signed-out shell: wordmark, Status, Sign in. | UI-10 |
| 15 | P3 | S02–S18 | Motion gaps (code review): dialogs and menus have no enter/exit; no pressed state on buttons; tabs have no moving indicator. Existing motion is purposeful and reduced-motion safe (verdict fill, judging pulse, score flash, board spring, resolver). | Add the three, nothing else; keep the reduced-motion block. | UI-09 |
| 16 | P3 | S17 | The one gradient in the product is Monaco's diff viewer (all themes). Our source has none. | Override in the diff theme/CSS so the rule holds on screen too. | UI-13 |
| 17 | P3 | S05, S06, S09 | Monaco default bracket colours (gold `255,215,0`, blue `4,49,250`) leak into the editor (56 elements each). | Set bracket foregrounds in `lib/monaco-theme.ts`. | UI-11 |
| 18 | P3 | S12, S18, S14 | SVG label sizes off the type scale and possibly unreadable at 390 px (`architecture.tsx` 10, 10.5, 11 px; `rating-graph.tsx` 11 px); S18 diagram has label overlaps; rating graph sits in an 860 px column leaving 400 px empty; scrubber is a bare 5 px track. | Labels on the scale at fixed rendered size; fix overlaps; hairline figures; bigger scrubber hit area. | S12 UI-12 · S14, S18 UI-13 |
| 19 | P3 | S03 | 780 px content column leaves ~300 px dead at 1280; five equal cards, no focal point. | Rework home around one next action. | UI-10 |
| 20 | P3 | S17, S11 | Copy: "3 times" style counts (`integrity-review.tsx:297`), and the tracker line "None found." has no next step. | Pluralise and add a next step. | UI-13 · UI-12 |
| 21 | P3 | S10 | Own row marked only by a faint tint and "(you)". | Anchor row, stronger marker, not colour alone. | UI-12 |
| 22 | P3 | tests/docs | Detector items: `presence.tsx:20` 2 px radius (remote-cursor label, acceptable), SVG sizes (see 18). Dark captures have +4 elements vs light, unidentified (*verify*; layout, sizes and radii match). | Document exceptions in `UI_UX.md`; confirm the +4 elements. | UI-14 |

Every row has an owner; nothing is unowned.

### Progress

| Card | Rows resolved | Notes |
|---|---|---|
| UI-09 (2026-10-10) | 2, 3, 6, 7 (scale), 8 (button), 9, 15 | Rail "clipped" (9) was a full-page capture artefact. |
| UI-10 (2026-10-10) | 1, 5 (S03), 8 (S02), 12 (S04), 14, 19 | S01 landing built (own shell, evidence from METRICS.md); S03 wraps long handles and leads with the countdown; S04 shows Status and Title on phones with the rest under the title; signed-out shell has no rail. After-captures in `docs/design/pilot/`. Open for S01 to S04: row 6 CJK glyphs need a live check on a machine with CJK fonts. |
| UI-11 (2026-10-10) | 7 (S05, S06), 12 (S05, S06), 13 (S06), 17 | S06 has a visible h1 (28) over 18 px sections; markdown headings in statements now 22/18/16; one date format (`10 Oct 2026, 10:00 IST`); test numbers never wrap; the Run/Submit bar sits above the 56 px bottom bar (it overlapped by 8 px after UI-09); Monaco bracket colours come from the palette. |
| UI-12 (2026-10-10) | 4, 5 (S08, S12), 7 (S11), 10 (S07), 12 (S09, S10), 13 (S07, S08: shortened), 18 (S12), 21 | Stage density on S08, S10, S11: display countdown, standing strip, large rank and rating change with a sentence and one next step, visible freeze notice; S07 one filled action per row; S12 two columns with a graph that keeps its label size on phones. Row 13: US-4.1 requires both zones, so the second zone now repeats only the time. Row 20 (S11 "None found.") is AI-written text, not ours; the "3 times" count stays with UI-13. |

## Strengths to keep

S06's submission journey (checkmarks with ms offsets and per-test table) is the clearest expression of "show the system"; S18's narrative page and honest diagram; verdicts always carry a text label; tabular mono numerals; visible keyboard shortcuts on S05 and S09; focus ring and reduced-motion handling; a token pipeline with zero raw colours and perfect dark/light parity; no horizontal overflow on any normal capture.

## Break-ui worst-case results (S03, S06, S08, S10, S12, S17)

Data used: 64-character handle, mixed CJK/Cyrillic/Arabic handle, one-letter handle, 14 list items with very long and emoji titles, 60 tests with a 400-fold compile log and long checker message, 99 999 ms and 2 147 483 647 KB, 153 board rows with 9999-minute and 98-attempt cells, 12 345 solved and rating 99 999, 40 tags. Results: **overflow at 390 on S03, S08, S12, S17 (finding 5); tofu glyphs (6); S06 numeric cells wrap and the page reaches 3264 px (12); the board holds 153 rows inside a scroll container at 1280 and stays usable (a pass); S10 worst-case columns fit at 390.** No crash or blank state in any of the 12.

## Proposed dependencies

None added in this card; see DIRECTION.md.
