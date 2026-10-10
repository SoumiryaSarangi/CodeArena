# Design direction: "Match Day" (proposal, UI-08)

Status: **approved by Ayush on 2026-10-10 and built in UI-09 to UI-13; see "As built" at the end** (all four open questions answered yes; see the end). Nothing here is built yet; UI-09 starts it. Evidence: `docs/design/AUDIT.md`, the 100 captures in `docs/design/screens/`, the references in `docs/design-refs/`. The only rule that was fixed beforehand: **no gradients** (that includes glows and image fades).

## The decision in one paragraph

Today CodeArena looks like every dark developer tool: black canvas, grey boxes, one violet accent, 12 px text everywhere, and no moment that says *contest*. The redesign keeps it quiet and precise but gives it one idea: **type does the work, colour means state, and the screens that people watch together get to be big.** Two densities, one system: **Stage** (landing, lobby, arena chrome, board, results) is large, spacious and readable from a shared screen; **Workbench** (practice list, editor, admin, pad) stays dense and fast. Everything is neutral, hairline-bordered and flat; the brand shows up in the wordmark, the numerals and the contest moments.

## Why this one (plain language)

- **The product's promise is "show the system".** Verdicts, queue position, ranks and countdowns are the product. So the numbers get the big type, not the decoration. A screenshot of the board should be recognisable by its huge rank and tabular numerals, not by a colour.
- **Contest day is the peak and is currently the flattest part** (board is a 12 px table; results bury the rating change). Stage density fixes exactly that, and costs nothing on the practice screens.
- **It cannot be mistaken for the template.** Colour is spent on meaning (AC green, WA red…) and on one brand blue; primary buttons are ink-on-paper rather than violet. That removes the shadcn/violet look immediately.
- **It is cheap and testable.** It is a token change (UI-09) plus per-screen layout work, not new components or new libraries. Existing tests stay the gate.
- **Honest.** No invented logos, customers or screenshots. Proof on the landing page is the measured numbers in `docs/METRICS.md`.

## Tokens it implies (UI-09 implements; values are the starting point)

**Palette.** Neutral ladder carries 90% of the UI; hue only for state and one brand colour.
- Dark: page `#0b0c0e`, panel `#111316`, raised `#171a1e`, hairline `#23272d`, strong border `#4a515b` (≥3:1 as today), text `#ececee`, text-2 `#a3a9b2`, text-3 `#8a909a` (must stay ≥4.5:1 on every surface; measured today: lowest 4.69:1).
- Light: page `#fafafa`, panel `#ffffff`, raised `#f2f3f5`, hairline `#e4e6ea`, text `#14161a`.
- Brand blue (rank 1, focus ring, links, wordmark mark, countdown accent): dark `#6d8bff`, light `#2f49d9`. **Replaces violet `#8b7fff`.** Not used for fills of large areas.
- Primary button: ink on paper (dark theme: light fill, dark text; light theme: dark fill, light text). One per view.
- Verdict colours keep their meaning and the text label; re-tune only to stay ≥4.5:1 on the new surfaces (today's thinnest: light WA 4.83, TLE 5.02). Presence colours unchanged.
- No gradients, no glows, one overlay shadow (dialogs and menus only).

**Type.** Geist Sans and Geist Mono stay (already shipped, free, tabular numerals, one family fewer to load); the change is size, not face.
- **Root font size 16 px** (drops the 14 px root trick, so browser zoom and user font settings work). Scale in rem: meta 12 px (the floor, nothing smaller except tabular digits in badges at 11), small 13, **body 14**, reading 16 (problem statements, results prose), h3 18, h2 22, h1 28, **display 40 / 56 / 72** for Stage numerals (rank, countdown, rating change, landing hero).
- Heading ladder with ≥1.25 ratio between levels, one h1 per screen. Negative tracking on display sizes (−0.02 em); weights 400/500/600 only.
- Numerals: Geist Mono with tabular figures everywhere a number can change or be compared.
- Font stack gets a CJK/emoji-capable system fallback (worst-case captures show tofu boxes for `李小龍_Алексей_مرحبا`).

**Spacing and density.** 4 px base, 8 px rhythm. Controls 36 px high on desktop; **44 px hit area under 768 px or on coarse pointers** (today 60% of controls on phones are under 32 px). Dense tables keep 32 px rows with a 44 px hit area through padding.
- *Workbench* (S04, S05, S13 pad, S15 to S17): current density, but body 14 not 12.25.
- *Stage* (S01, S08, S09 header, S10, S11, S18): roomy, 24 to 40 px section gaps, display numerals.

**Shape.** Radii 4 (controls) and 8 (panels, dialogs); pills only for status. Borders are 1 px hairlines; cards are flat. Content width: Workbench uses the full width up to 1440; Stage uses a centred 1120 column.

**Motion.** Keep the existing tokens (120 / 180 / 350 ms, `cubic-bezier(0.2,0,0,1)`) and the reduced-motion block. Add only what the audit found missing: dialog and menu enter/exit (opacity and 4 px translate, 180 ms), a pressed state on buttons (scale 0.98, 120 ms), a sliding underline on tabs, and keep the board's rank-change spring and the verdict fill. Nothing loops except the judging pulse. Everything off under reduced motion.

**Hairline figures** (`@lucasmarkes/hairline`, pre-approved): thin-line data figures where numbers need a shape, not decoration. Proposed places: (1) rating graph on S12; (2) the "journey" figure of one submission on the landing page (queue, claim, compile, run, verdict with real millisecond offsets); (3) the architecture diagram on S18; (4) replay scrubber ticks on S14; (5) a per-problem solve sparkline on S10 if UI-12 has room. Nowhere else.

## Surfaces, one line each

- **S01 landing:** own shell (no app rail), tagline "The place your campus codes together", one primary action, the journey figure, a row of measured proof from METRICS.md, a link to S18. Only evidence that exists.
- **S10 board and S11 results:** Stage. Large rank, your row anchored, freeze banner, rating change as a display numeral with a sentence that frames wins and losses.
- **S08 lobby / S09 arena:** Stage header with contest state and time-left as the one big element; arena keeps the editor dense.
- **S05, S06:** Workbench. S06's journey timeline is the product's signature; give it room.
- **S13 to S17:** Workbench with a status-first admin page (health banner first, actions grouped by risk, destructive ones separated and confirmed).

## Proposed dependencies

| Dependency | Use | Status |
|---|---|---|
| `@lucasmarkes/hairline` | the five figures above | pre-approved in CLAUDE.md; added in UI-09 or the first card that uses it |
| Anything `pick-ui-library` recommends | to be run once, at the start of UI-09, for dialog/menu/tab primitives | pre-approved, but list it in that PR and in `docs/design-skills.md` |

No new fonts, no animation library (the app already uses `motion` for the board and resolver; verify in UI-09 before adding anything).

## Deliberately not doing

Gradients, glows, blurred backdrops, illustrations, mascots, a logo (a wordmark may be set in Geist Mono), testimonials or user counts (none exist), a separate marketing site, new colour for every feature, and redesigning the Monaco editor beyond its theme.

## Decisions (Ayush, 2026-10-10)

1. Brand blue replaces violet: **yes.**
2. Ink-on-paper primary buttons: **yes.**
3. Root font size 16 px: **yes** (left to the builder's judgement; accepted).
4. Stage and Workbench density split: **yes.**

## As built (UI-14, 2026-10-10)

What shipped against what this document proposed. The values are in `apps/web/app/tokens.css`; `docs/UI_UX.md` §5 and §8.1 are the reference and a test keeps them equal to the code.

| Proposed | Built |
|---|---|
| Blue replaces violet | Yes: `#6d8bff` dark, `#2f49d9` light. |
| Ink-on-paper primary buttons | Yes (`--primary`); blue kept as a separate, rare `accent` button variant. |
| Root font 16 px, ladder 28 / 22 / 18, display 40 to 72 | Yes; 12 px is the floor, SVG labels included. |
| Radii 4 and 8 | 4 / 6 / 8: controls stayed at 6 (reads better on a 36 px control; 78 call sites untouched). |
| Stage and Workbench densities | Yes: display numerals, 44 px rows and a centred 1120 px column on lobby, board, results and status; dense elsewhere. `Stage` and `Workbench` wrappers exist in `components/shell/page-width.tsx`, but screens set their own max widths, so the wrappers are not yet used. |
| Motion: dialog enter and exit, pressed state, tab indicator | Dialog/drawer animation and the pressed state; the tab underline changes colour rather than sliding. |
| Hairline figures (`@lucasmarkes/hairline`) in five places | **Not built.** No dependency was added; the rating graph, the journey list and the architecture diagram are plain SVG and lists. A candidate for a later card. |
| No gradients | Held, including Monaco's diff hatch (switched off in `globals.css`). |
| Touch targets | A 44 px hit area on touch and under 768 px (`hit-44`), plus 44 px tabs and menu items. |
| Light-theme contrast margin | Light verdict colours darkened (AC, TLE, RE) to at least 4.6:1 on the darkest light surface, checked by a test. |

Things the redesign added that this document did not propose: a bare shell for signed-out visitors, a health banner and risk-grouped actions on the ops console, a "Your standing" strip on the board, the rating change said in words with one next step on results, and scroll regions that are `position: relative` so hidden text cannot widen the page.
