---
name: CodeArena
description: The place your campus codes together. Practise, compete and interview on a judge you can trust.
colors:
  primary: '#ececee'
  primary-hover: '#d0d3d8'
  on-primary: '#0b0c0e'
  accent: '#6d8bff'
  accent-hover: '#8199ff'
  focus-ring: '#8ea4ff'
  ink: '#0b0c0e'
  surface-1: '#111316'
  surface-2: '#171a1e'
  surface-3: '#1e2227'
  hairline: '#23272d'
  divider: '#2f343b'
  control-edge: '#5a626e'
  text: '#ececee'
  text-secondary: '#a3a9b2'
  text-tertiary: '#8a909a'
  verdict-accepted: '#22c55e'
  verdict-wrong-answer: '#f87171'
  verdict-time-limit: '#f59e0b'
  verdict-memory-limit: '#f472b6'
  verdict-runtime-error: '#f97316'
  verdict-compile-error: '#94a3b8'
  verdict-output-limit: '#14b8a6'
  danger: '#f87171'
  warning: '#f59e0b'
  success: '#22c55e'
  info: '#60a5fa'
typography:
  display:
    fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '2.5rem'
    fontWeight: 600
    lineHeight: '2.75rem'
    letterSpacing: '-0.02em'
  headline:
    fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.75rem'
    fontWeight: 600
    lineHeight: '2.25rem'
    letterSpacing: '-0.01em'
  title:
    fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.375rem'
    fontWeight: 600
    lineHeight: '1.75rem'
  body:
    fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: '1.25rem'
  label:
    fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.8125rem'
    fontWeight: 500
    lineHeight: '1.25rem'
  mono:
    fontFamily: 'Geist Mono, ui-monospace, monospace'
    fontSize: '0.75rem'
    fontWeight: 500
    lineHeight: '1rem'
rounded:
  sm: '4px'
  md: '6px'
  lg: '8px'
  full: '9999px'
  cursor-flag: '2px'
spacing:
  base: '4px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    rounded: '{rounded.md}'
    height: '36px'
    padding: '0 12px'
  button-primary-hover:
    backgroundColor: '{colors.primary-hover}'
  button-secondary:
    backgroundColor: '{colors.surface-2}'
    textColor: '{colors.text}'
    rounded: '{rounded.md}'
    height: '36px'
    padding: '0 12px'
  button-secondary-hover:
    backgroundColor: '{colors.surface-3}'
  button-ghost:
    textColor: '{colors.text-secondary}'
    rounded: '{rounded.md}'
    height: '36px'
    padding: '0 12px'
  button-danger:
    backgroundColor: '{colors.danger}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    height: '36px'
    padding: '0 12px'
  input:
    backgroundColor: '{colors.surface-1}'
    textColor: '{colors.text}'
    rounded: '{rounded.md}'
    height: '36px'
    padding: '0 12px'
  verdict-badge:
    textColor: '{colors.verdict-accepted}'
    typography: '{typography.mono}'
    rounded: '{rounded.sm}'
    padding: '2px 6px'
---

# Design System: CodeArena

> **Status: written 2026-10-10 (UI-14) to match what UI-09 to UI-13 built.** It supersedes the record of the incumbent look made on 2026-10-09. The numbers live in `app/tokens.css` and `app/globals.css`, the full reference is `docs/UI_UX.md` §5, the reasoning is `docs/design/DIRECTION.md`, and what was wrong before is `docs/design/AUDIT.md`. Where this file and the code disagree, the code wins.

## Overview

**Creative North Star: "Match Day"** (DIRECTION.md). Type does the work, colour means state, and the screens people watch together are allowed to be big.

The product is a judge and contest platform for a campus, so the interface is an instrument first and a brand second: calm neutral surfaces, hairline borders, monospace numerals, and colour only where it carries meaning (verdicts, live state, focus). Two densities share one system. **Stage** screens (landing, lobby, board, results, status) are roomy, centred in a 1120 px column and use display numerals (rank, rating change, countdown at 40 to 72 px). **Workbench** screens (practice, editor, pad, admin) stay dense and use the full width.

**Key Characteristics:**

- Dark-first with full light-theme parity, both contrast-checked in tests (WCAG AA); the theme follows the system.
- **Ink on paper for the one primary action** of a view (light fill and dark text in dark mode, the reverse in light mode). Blue is the identity colour: wordmark caret, focus ring, links, selection, live states. It is never used to fill large areas.
- Verdict colours are semantic and always paired with a text label.
- Flat: depth through tonal layers and 1 px hairlines; one overlay shadow for dialogs and menus. **No gradients**, including Monaco's diff hatch (switched off).
- Root font size is the browser's 16 px; body 14, meta floor 12, headings 28 / 22 / 18, display 40 to 72.
- 44 px hit areas on touch and under 768 px, with no change to how small controls look.
- Colours exist only as tokens (`@theme inline { --color-*: initial }` removes the default palette); `monaco-theme.ts` is the one other file with hex values.

## Colors

Neutral first: a near-black canvas (`#0b0c0e`) with three surface steps in the dark theme, a warm-white (`#fafafa`) canvas with white panels in the light theme. Values are in `tokens.css`.

### Primary (ink) and accent (blue)

- **Primary** (`--primary`, `#ececee` dark / `#14161a` light): filled primary buttons and the active tab underline. One per view.
- **Accent blue** (`--accent`, `#6d8bff` dark / `#2f49d9` light): the wordmark caret, focus ring, links, text selection, the "judging" pulse and live flash, rank 1 and chart lines. 6.3:1 and 6.5:1 on the canvas.

### Neutral

Surface 1, 2, 3 are the top bar and inputs, cards and secondary buttons, hover and raised. `--border` is decorative only; `--border-strong` divides regions; `--border-control` (3.2:1 / 3.0:1) outlines inputs. Text, secondary and tertiary text reach 16.6, 8.3 and 6.1:1 on the dark canvas; the tertiary value is the floor and "never lighter".

### Verdicts and status

AC green, WA red, TLE amber, MLE pink, RE orange, CE slate, OLE teal, SE the text colour. In the light theme they are darkened (AC `#146c35`, TLE `#a04a06`, RE `#b83b0b`) so they stay at least 4.6:1 on the darkest light surface; a test checks every verdict colour on surface 2 and 3 in both themes.

### Named Rules

- **Colour means something.** Verdicts, live state, focus, and the one blue. Everything else is neutral.
- **Never colour alone.** Every verdict has its letters; board cells use ✓, +n and ?n; your row has a bar as well as a tint.
- **One filled button.** A view or row has one ink-filled action; the others are secondary or ghost.

## Typography

**Geist Sans** for the interface, **Geist Mono** for code, numbers, timers, verdict labels and handles, with system CJK, Arabic and emoji faces after them. Tabular numerals wherever a number can change.

### Hierarchy

| Role      | Size / line height                                     | Use                                                                 |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| Display   | 40 to 72 px, weight 600, tracking −0.02em              | rank, rating change, countdown, landing heading                     |
| h1        | 28 / 36, 600                                           | page title, one per screen (22 px in the workspace and pad headers) |
| h2        | 22 / 28 on Stage screens, 18 / 26 on Workbench screens | sections                                                            |
| h3        | 18 or 16                                               | sub-sections, problem cards                                         |
| Statement | 16 / 27                                                | problem statements and prose                                        |
| Body      | 14 / 20                                                | the interface                                                       |
| Dense     | 13 / 20                                                | tables, console, captions                                           |
| Meta      | 12 / 16, 500                                           | badges, labels: the floor                                           |

### Named Rules

- **12 is the floor.** Nothing renders smaller; SVG labels are on the scale too.
- **One h1 per screen, 1.2× between levels.**

## Layout

App shell: a sticky 48 px top bar, a rail (56 px bottom bar on phones, 56 px icon rail from 768 px, 192 px rail with labels from 1280 px) and content up to 1440 px with 16 / 24 px gutters. Stage screens centre a 1120 px column; Workbench screens use the full width. Signed-out visitors on `/` and `/signin` get a bare shell (wordmark, system dot, theme, Sign in). Tables scroll inside their own labelled, focusable box; the page itself never scrolls sideways.

## Elevation & Depth

Flat by default. Dialogs, drawers, menus and tooltips use `--shadow-overlay` (`0 8px 24px` at 35% black in dark, 12% in light) and a 1 px strong border.

### Named Rules

- **Tone, not shadow.** Raise by surface step. Only things that float get a shadow.
- **No gradients, no glows. Blur only on floating chrome**, never as decoration and never over live text.

## Shapes

Radii 4 px (badges, cells), 6 px (buttons, inputs), 8 px (panels, cards, dialogs), pills only for status. Borders 1 px.

## Components

### Buttons

Heights 32 / 36 / 40 px, radius 6 px, weight 500, a 44 px hit area on touch. **Primary** is ink on paper; **accent** is a blue fill for a rare brand moment (never beside a primary); **secondary** is surface 2 with a control-edge border; **ghost** is text only; **danger** is the danger colour. Pressed scales to 0.98; disabled is flat surface 3 with tertiary text (never half-transparent). Loading keeps the width.

### Inputs / Fields

36 px (44 px under 768 px), control-edge border, 2 px focus ring in the focus colour with a 2 px offset, errors in words with an icon below.

### Tabs

Underline style: a 2 px primary underline and medium weight on the active tab; 44 px tall under 768 px.

### Verdict Badge (signature component)

Monospace 12 px label (AC, WA on test 3…) in a tinted box in the dark theme and a 1 px ring in the light theme; pending pulses.

### Wordmark (top bar only)

`codearena` in Space Grotesk Bold (a 1 KB subset loaded only by this component): "code" in the blue, "arena" in the text colour, a thin blue caret bar. Solid colours from `--wordmark-*`. Anywhere else the name is plain text.

### Submission wire

Five 3 px segments that fill from the real submission events (queued, claimed, compiling, running) and settle in the verdict colour. Under Submit, on the phone action bar, on the home recent rows and on board rows (there read from the board's own diffs). Feedback only: the words that say the same thing are beside it.

### Handle (tier)

A handle in its rating tier's colour with the tier word in the tooltip and for screen readers; neutral at the starting 1400.

### Landing

The tagline, a framed judge window that lights the six steps of one submission once, a live strip of recent public practice verdicts (hidden when empty), proof as display numerals each with its run and date, the 500-run verdict mix, and a sample scoreboard marked as sample data.

### Navigation

Left rail with an active marker bar plus weight (not tint alone); 56 px bottom bar with labels on phones.

### Overlays

Dialogs and drawers fade and move 4 px in 180 ms and out in 120 ms; the drawer slides 16 px. All motion is off under reduced motion.

## Do's and Don'ts

### Do:

- Give each view one ink-filled action and make the rest quiet.
- Show what the product is doing (the wire, the live strip) with real events, and show nothing when there is nothing.
- Say a number in words next to its display numeral (rating change, rank).
- Use display sizes for what people watch together, and keep working screens dense.
- Keep tertiary text at its floor value or darker; check any new surface against the tests.
- Measure SVG figures to their box so labels keep their size on a phone.

### Don't:

- Add a gradient, glow or pattern, including third-party ones (Monaco's hatch is overridden), or blur the editor or the board.
- Fill with blue, or put a blue button next to an ink one.
- Use a size below 12 px, or colour as the only signal.
- Let a long handle, title or table widen the page: wrap, truncate with the full value in `title`, or scroll inside a labelled box.
