# Round 2: raising the built UI (UI-15, proposal for UI-16 to UI-19)

Status: **written 2026-10-10 as part of UI-15.** Round 2 supersedes `docs/design/DIRECTION.md` where they differ. Nothing here needs a new API unless it says so. Evidence: 112 captures of the built UI (`docs/design/round2/before/`), three read-only reviews (a design critique, a measured-evidence audit with the Impeccable detector, and motion / mobile / worst-case lenses from `review-animations`, `find-animation-opportunities`, `mobile-native` and `break-ui`), the `apple-design` and `emil-design-eng` lenses, and `docs/design-refs/`.

## In plain words

Round 1 made the app clean and consistent. It is still **plain**: one family of type at one weight, one colour (blue, about 2% of the pixels), four tones of grey, and no object on any screen that is specifically *about* codearena. Put another product's name in the top bar and every screen would still work. Compared with LeetCode and Codeforces it is also **less dense and less colourful where those sites use colour to carry meaning** (difficulty, rating tier), and the landing page is a big sentence on a mostly empty page.

Round 2 does three things: it gives the product **a face** (wordmark, a landing page that shows the product working, tier and difficulty colour that carries meaning), it makes the workbench screens **denser and quicker** (the LeetCode/Codeforces feel), and it adds **Apple-style polish where it is cheap and safe** (press feedback that really works, sheets on phones, frosted overlays) without touching the editor or the board. The two hard limits still hold: **no gradients** (no glows or fades either) and **only real numbers**.

Scores from the reviews: usability 29/40 (good), distinctiveness poor; audit health 16/20; the detector found nothing; no screen overflows sideways; zero gradients in all 112 captures.

## What is already good and stays

1. **Ink-on-paper primary button**, one per view. It reads as "the one action" everywhere.
2. **Verdict badges and board cells** (AC / WA on test 3, ✓ 12 ★, +2, ?1): text always present, never colour alone.
3. **The Stage / Workbench split.** The lobby countdown, the board standing and the results numerals are the best-composed moments.
4. **The submission journey (S06) and the status page (S18).** They are the product's real differentiators. Round 2 puts them on the front door instead of hiding them.
5. **Token discipline**: tests that forbid raw colours, light/dark parity, the UI_UX-to-code drift tests, 44 px hit areas, no overflow.

## What changes, ranked, with the owning card

| # | Pri | Where | Change | Card |
|---|---|---|---|---|
| 1 | P0 | S01 landing | The landing shows the product: a hero that plays one real-timed verdict journey; the proof as large numerals with the run behind each; the verdict mix of the 500-run load test as a proportional bar; a framed sample board. Details below. | UI-16 |
| 2 | P1 | all | **Colour that carries meaning**: tier colours on handles (with the tier word always), difficulty colour with its word on S04. No new brand colour. | tokens UI-15, use UI-17/18 |
| 3 | P1 | top bar | **Wordmark twist** (the owner's request): own typeface, two solid colours, tiny subset font, only in the top bar. | UI-15 |
| 4 | P1 | S05 | Editor status strip (language, saved) and a live verdict strip under Submit showing the journey inline. | UI-17 |
| 5 | P2 | S04, S07 | Denser rows (32 to 36 px), tag chips, a solved counter, per-row countdown and counts, a visible Standings link. | UI-17, UI-18 |
| 6 | P2 | S10 | 36 px rows, rank 1 to 3 marks, "first to solve" more visible than a small star, your row pinned at the edge of the scroll box, on phones Solved and Penalty merge into one line so two problem columns fit. | UI-18 |
| 7 | P2 | all | **Type has more range**: Stage body at 16, a clearer heading ladder (one size per level), numerals in Geist Mono with tabular figures everywhere a number is compared. | UI-16 to UI-19 |
| 8 | P2 | landing | Evidence copy fixed to match `docs/METRICS.md` exactly (done in UI-15, see below). | UI-15 |
| 9 | P2 | pending badge | `judging…` text on its tint measured 4.19:1 in dark; lightened and covered by a test. | UI-15 |
| 10 | P2 | motion | The button's colour transition never worked (`transition-[colors,transform]` is not valid CSS, and Tailwind v4 scales with the `scale` property); fixed. Stronger ease-out curve; reduced-motion keeps a 100 ms fade instead of killing feedback. | UI-15 |
| 11 | P2 | phones | Mobile-native basics: a `viewport` export with `theme-color` for both themes, safe-area padding, no grey tap flash, `overscroll-behavior`, 16 px inputs on touch (no iOS zoom), `user-select: none` on controls. | UI-15 |
| 12 | P3 | S03, S06, S12, S17 | Worst-case fixes: one-line titles with `title=`, status glyph instead of a word, passed tests collapsed on S06, tag list capped at 10 on S12 and `<wbr>` after underscores in long handles, stacked cards for the S17 tables on phones, `<bdi>` around handles. | UI-17 to UI-19 |
| 13 | P3 | S02 | First run is bare: a short "what you get" panel beside the form. | UI-17 |

## Fonts

- **UI and body: Geist Sans, unchanged.** It is already loaded, has tabular numerals, and a second text face would cost every page a request.
- **Numbers, handles, nav labels, table headers: Geist Mono, used more.** The "mono-forward" direction sells the product as a judge and costs nothing. Display numerals (rank, rating change, countdown, the landing proof) stay in Geist Mono at 40 to 96 px.
- **The wordmark gets the one new face** (below), because the owner asked for it and a subset of 8 letters is tiny.
- Not adopted now: a display face on every Stage heading (it would add weight to every Stage page for little gain; revisit in UI-16 only if the landing needs it).

## Colours

- **Keep:** canvas, three surfaces, text ladder, ink primary, blue identity, verdict colours (all contrast-tested).
- **Add (tokens, both themes, each ≥ 4.5:1 on surface 1 to 3, always shown with its word):** tier colours for Newcomer, Pupil, Specialist, Expert, Master (the words already exist in `lib/profile.ts`); difficulty text colours for Easy / Medium / Hard as **aliases of existing tokens** (success, warning, danger) so no new hue is needed.
- **Not adopted:** a second brand accent (a yellow for "live"). Amber already means TLE and the warning state; reusing it would blur two meanings. The "paper and ink" warm light theme was considered and rejected for now: the owner approved the neutral and blue direction in round 1.

## Materials (the "Deliberately not doing" list is revisited)

- **Blurred backdrops: now allowed, narrowly.** CSS `backdrop-filter` (live, no dependency) on **floating chrome only**: the Ctrl+K palette, dialogs and drawers, toasts, the phone bottom bar and the sticky top bar. Each is a hairline-edged panel at about 82% of surface 1 with a 14 px blur (`--glass`), opaque when the user asks for reduced transparency and when the browser has no `backdrop-filter`. Never on the editor, the board, tables or the diff view (blur costs frames while text changes).
- **liquid-glass-js: not adopted.** It refracts one frozen html2canvas snapshot of the page and needs two new dependencies; that suits a static backdrop, not live content. If the landing hero ever wants one glass object over a static background, I describe it and **wait for your yes**.
- **Illustrations and mascots: still no.** **Imagery: yes, but real**: framed captures of the product (clearly marked as sample data) on the landing page. **A logo:** the wordmark twist is the logo.
- **Gradients, glows, fades: still banned**, as before.

## Motion

Kept: dialog and drawer enter and exit, the verdict fill, the judging pulse, the board spring (0.35 s) and the resolver spring (0.5 s).
Changed or added (all flat, reduced-motion safe): working press feedback (`scale: 0.97`, 120 ms) on buttons, rail items and tabs; stronger ease-out `cubic-bezier(0.23, 1, 0.32, 1)`; a phone drawer that slides as a sheet (`translateX(100%)`, 240 ms, exit 160 ms); verdict swatches fill only when a test result arrives, not on page load; a 700 ms colour decay on a board rank change (capped); tooltip skip-delay; reduced motion keeps a 100 ms opacity fade.
Not animated, on purpose: the editor, tab content swaps, the command palette, table sorting, live numbers on the board, route changes.

## The wordmark (top bar only)

- **Typeface:** Space Grotesk Bold (SIL OFL), chosen after rendering it against two other candidates on the real top-bar background in both themes (the comparison is in `docs/design/round2/after/wordmark-candidates.jpg`). It is geometric with a distinctive `a` and `r`, and clearly not Geist.
- **Colour twist:** two solid colours: **"code" in the blue** (`--wordmark-code`, an alias of `--accent`), **"arena" in the text colour** (`--wordmark-arena`, an alias of `--text`), and a thin caret bar in the blue again (`--wordmark-caret`), so the blue brackets the word. The caret is a CSS bar, not a glyph (a full-block caret was too heavy at this size in the comparison). Both themes, contrast ≥ 4.5:1 on the bar by test.
- **Mechanics:** the font is subset to the letters `codearena` (about 2 to 4 KB woff2; `scripts/subset-wordmark.sh` regenerates it), committed under `apps/web/app/fonts/` with its licence, loaded with `next/font/local` **only in the wordmark component**. Spelling stays `codearena`; the link's accessible name is exactly "codearena" (the caret is `aria-hidden`). Everywhere else, the name stays plain.

## The twist (the one thing that makes codearena itself)

1. **Tier-coloured handles everywhere (purely visual, small): adopted.** On the board, profile, results and contests the handle takes the tier colour and the tier word appears on hover and in the profile. It is the Codeforces idiom and puts colour on the board without any new data. Cards UI-17 and UI-18.
2. **"The wire": a thin segmented line under every submission** (Submitted → Verdict, driven by the real submission events, settling into the verdict colour) under the Submit button, on board rows and on the Recent submissions list. It would make "transparent judging" the signature motion. **Needs new work, not a visual tweak:** a small shared component plus a per-row live subscription on the board and home (the events exist; the board does not subscribe per row). **Cost: about 2 to 3 days, medium risk on the board.** **Waits for your yes.**
3. **A live verdict ticker on the landing page** (the original S01 spec). **Needs a new public endpoint** returning the last 10 anonymised verdicts (language, problem label, verdict, time; no handles), rate-limited and cached 5 s, plus a pause control. **Cost: about 1 to 2 days.** It would also show real activity only when there is some. **Waits for your yes.**

## Decisions from Ayush (2026-10-10)

- **"The wire": yes.** Built in **UI-17** (under the Submit button on S05 and on the Recent submissions list on S03) and **UI-18** (the board rows on S10, which needs a per-row live subscription: the risky part).
- **The live verdict ticker on the landing: yes.** Built in **UI-16** (`GET /api/status/verdicts`: practice, public problems only, anonymised, cached 5 s).

## The landing page (UI-16 plan)

Concept chosen: **"Watch a verdict happen"**, built from facts that already exist, so **no new API**:

1. **Hero:** the tagline, one primary action, and beside or under it a framed object that plays **one journey**: Submitted → Queued → Claimed → Compiled → Run → Verdict, lighting up in sequence over about two seconds, ending on AC. The timings it shows are the measured ones in METRICS.md (queue wait p50 0.0 s and p95 0.5 s; time to verdict p50 0.4 s and p95 2.1 s on production), labelled as measured, not as this submission's. It loops once and then rests; it stops for reduced motion.
2. **Proof as numerals, not sentences:** 2.1 s, 28, 6, 2.1 ms at display size in Geist Mono with the run behind each one in small text and the same caveats METRICS.md writes.
3. **The 500-run verdict mix** as one proportional bar with the real counts (AC 337, WA 108, TLE 44, RE 11) and the two-judge versus one-judge comparison from METRICS.md.
4. **A framed sample board** (a capture from the existing harness, marked "sample data") so a visitor sees what a contest looks like.
5. The landing gets the frosted sticky header only if it scrolls under it.

## Dependencies

None proposed for UI-15 to UI-19. `liquid-glass-js` (and its html2canvas) only if you say yes to a glass hero object. `@lucasmarkes/hairline` stays pre-approved but is not needed by this plan.

## Done in UI-15 itself

The wordmark; tier and wordmark tokens; the pending-badge contrast; the button transition and press feedback; the stronger ease-out; gentler reduced motion; the mobile-native basics; frosted floating chrome; the off-token `shadow-lg` in the tag filter; `scripts/sync-ui-ux.mjs`; and a **truthfulness fix to the landing evidence** (the 28 attack programs are now a counted fact in METRICS.md with its date; "200 watching" became "195 of 200 connected"; each statement names its run and date). Everything per screen is in UI-16 to UI-19.

## What I could not measure

LeetCode and Codeforces answer automated browsers with a bot check, so they were **skipped without any workaround** (`docs/design-refs/README.md`). Their density and feel come from your brief and from the reviews of our own screens. Touch behaviour (safe areas, keyboard overlap, zoom) needs a real phone; the code-verifiable parts are done.
