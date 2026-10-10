---
name: CodeArena
description: The place your campus codes together. Practise, compete and interview on a judge you can trust.
colors:
  primary: '#8b7fff'
  primary-hover: '#9d93ff'
  on-primary: '#0a0b0d'
  focus-ring: '#a99fff'
  ink: '#0a0b0d'
  surface-1: '#111317'
  surface-2: '#171a1f'
  surface-3: '#1e2228'
  hairline: '#23272e'
  divider: '#2f343c'
  control-edge: '#5a626e'
  text: '#e8eaed'
  text-secondary: '#a1a7b0'
  text-tertiary: '#858c97'
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
    fontSize: '3rem'
    fontWeight: 600
    lineHeight: '3.25rem'
  headline:
    fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.5rem'
    fontWeight: 600
    lineHeight: '2rem'
    letterSpacing: '-0.01em'
  title:
    fontFamily: 'Geist Sans, ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.25rem'
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
  lg: '10px'
spacing:
  base: '4px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    rounded: '{rounded.md}'
    height: '32px'
    padding: '0 12px'
  button-primary-hover:
    backgroundColor: '{colors.primary-hover}'
  button-secondary:
    backgroundColor: '{colors.surface-2}'
    textColor: '{colors.text}'
    rounded: '{rounded.md}'
    height: '32px'
    padding: '0 12px'
  button-secondary-hover:
    backgroundColor: '{colors.surface-3}'
  button-ghost:
    textColor: '{colors.text-secondary}'
    rounded: '{rounded.md}'
    height: '32px'
    padding: '0 12px'
  button-danger:
    backgroundColor: '{colors.danger}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    height: '32px'
    padding: '0 12px'
  input:
    backgroundColor: '{colors.surface-1}'
    textColor: '{colors.text}'
    rounded: '{rounded.md}'
    height: '32px'
    padding: '0 12px'
  verdict-badge:
    textColor: '{colors.verdict-accepted}'
    typography: '{typography.mono}'
    rounded: '{rounded.sm}'
    padding: '2px 6px'
---

# Design System: CodeArena

> **Status of this file: the incumbent look, recorded on 2026-10-09 before the redesign.** On the same day Ayush decided the current UI looks amateur and that the design skills decide the replacement (only "no gradients" stays). This file describes what is built so the audit (UI-08) and the redesign (UI-09 to UI-13) start from facts. UI-09 replaces the tokens, UI-14 rewrites this file to match what was built. Language marked _(inferred)_ was not confirmed by Ayush; the rest comes from the code or from `docs/UI_UX.md`.

## Overview

**Creative North Star: "The Instrument Panel"** (the name `docs/PLAN.md` §7.1 gave the intended direction; the look it describes was built, whether it achieves it is what UI-08 judges).

The intent was a calm, dense, precise tool, closer to a developer instrument than a consumer app: dark first with a full light theme, hairline borders, monospace for numbers and verdicts, colour reserved for meaning (verdicts, live state, one violet accent), and motion only to show that something changed. Today that comes out as a near-black canvas with grey layered surfaces, one violet accent and very small type: because the root font size is 14 px and every size is in `rem`, body text renders at **12.25 px**, labels at 10.5 to 11.4 px and the largest page heading at 21 px (measured on all screens, `docs/design/screens/data`). _(inferred)_ It reads as consistent but generic: every screen shares the same flat grey cards and small controls, there is no signature element, no wordmark beyond the text "codearena▍" in the top bar, and no hierarchy of scale (the largest everyday heading is 24 px).

**Key Characteristics:**

- Dark-first, light theme parity, both contrast-checked (WCAG AA); theme follows the system.
- One accent (violet), used for primary actions, active tab underline, focus, selection and the "judging" state.
- Verdict colours are semantic and always paired with a text label.
- Flat surfaces: depth through tonal layers and 1 px borders; a single overlay shadow.
- Small and dense: root font size 14 px with a `rem` scale, so body text is 12.25 px; controls 28/32/40 px tall.
- No gradients (the one rule Ayush keeps). Colours exist only as tokens: the default Tailwind palette is removed (`@theme inline { --color-*: initial }`).

## Colors

A near-black ink canvas with three grey surface steps, a cool-grey text ramp, one violet accent, and a semantic verdict palette. Values below are the dark theme; the light theme mirrors every token (`apps/web/app/tokens.css`).

### Primary

- **Signal Violet** (#8b7fff dark / #5b4be0 light): primary buttons, active tab underline, selection (35%), the "judging" pulse, the live flash on board rows, the cursor mark in the wordmark. Hover #9d93ff / #4f3fd6. Focus ring #a99fff / #5b4be0, 2 px with 2 px offset.

### Neutral

- **Ink** (#0a0b0d dark / #fafafb light): page background and the text colour on the accent.
- **Surface 1, 2, 3** (#111317, #171a1f, #1e2228 dark / #ffffff, #f4f5f7, #eceef1 light): top bar and inputs, cards and secondary buttons, hover and raised.
- **Hairline** (#23272e / #e3e5e8): decorative lines only. **Divider** (#2f343c / #d0d4da): borders between regions. **Control edge** (#5a626e / #8a919c): inputs and checkboxes, 3.2:1 on the background (WCAG 1.4.11).
- **Text, secondary, tertiary** (#e8eaed, #a1a7b0, #858c97 dark / #0f1114, #4b5260, #636a75 light). The tertiary value is "never lighter" (contrast floor).

### Verdicts and status

- Accepted #22c55e, Wrong answer #f87171, Time limit #f59e0b, Memory limit #f472b6, Runtime error #f97316, Compile error #94a3b8, Output limit #14b8a6, System error = text colour, Pending = accent. Danger #f87171, Warning #f59e0b, Success #22c55e, Info #60a5fa. Light theme uses darker equivalents for contrast.
- **Presence colours** (eight, #60a5fa #f472b6 #34d399 #fbbf24 #a78bfa #fb923c #22d3ee #f87171): the author colours of cursors and whiteboard shapes in an interview room, assigned by the server as an index.

### Named Rules

**The Tokens-Only Rule.** Raw colours live in `tokens.css` and `lib/monaco-theme.ts` (Monaco cannot read CSS variables) and nowhere else; UI code uses token classes.
**The Label Rule.** A verdict is never colour alone: it carries its text (AC, WA, TLE, …) in a monospace badge.

## Typography

**Display, Body and Label Font:** Geist Sans (with ui-sans-serif, system-ui). **Mono Font:** Geist Mono (verdicts, numbers, code, the wordmark).

**Character:** neutral and technical, one family in a narrow band of small sizes; the personality is carried by monospace numerals, not by the sans. The band is narrow (10.5 to 21 px for nearly everything), which is why screens read as flat.

### Hierarchy

The scale is defined in `rem` and the root font size is 14 px, so every size renders at 0.875 of its nominal value. Both are given: token name, rendered size.

- **Display** (600, `text-48` = 3rem, rendered **42 px** / 45.5 px): defined but not used on everyday screens.
- **Headline** (600, `text-24` = 1.5rem, rendered **21 px** / 28 px, tracking −0.01em): page titles; this is the largest text on almost every screen.
- **Title** (600, `text-20` = 1.25rem, rendered **17.5 px** / 24.5 px): section titles on some screens (results, workspace titles).
- **Body** (400, `text-14` = 0.875rem, rendered **12.25 px** / 17.5 px): running text, controls and table cells: about a third of all text on screen.
- **Label** (500, `text-13` = 0.8125rem, rendered **11.4 px** / 17.5 px) and **caption** (`text-12` = 0.75rem, rendered **10.5 px** / 14 px): form labels, secondary text, badges, chips; together about 45% of all text on screen.
- **Mono** (500, `text-12`, rendered 10.5 px): verdict badges, times, counters; tabular numerals via `.tabular`. `text-16` (1rem) renders at 14 px and `text-32` (2rem) at 28 px.

Measured share of text by rendered size across the 28 desktop dark captures: 12.25 px 31%, 11.4 px 29%, 14 px 16%, 10.5 px 15%, everything larger under 5%.

### Named Rules

**The Mono-For-Numbers Rule** _(inferred from usage)_. Anything the user compares (ranks, penalties, times, memory, verdicts) is monospace and tabular.

## Layout

An app shell: a sticky 48 px top bar (wordmark, search with ⌘K, status dot linking to the status page, account) with a 1 px divider, the main navigation, which is a fixed 48 px bottom tab bar on phones (icon over a 12 px label), a 56 px icon-only left rail from 768 px and a 192 px rail with labels from 1280 px, and content in a centred column (max 1440 px, 16 px side padding, 24 px from 768 px) below. The workspace (S05) is a resizable split of statement and editor. Tailwind's default breakpoints (640, 768, 1024, 1280) apply; screens are verified at 1280 px and 390 px. Spacing uses Tailwind's 4 px steps with no custom scale; `scroll-padding-top` is 96 px so sticky bars never hide a focused element. Coarse pointers get a 32 px minimum target. Content is dense: cards and tables with 12 to 16 px padding. Screens fully supported on phones: practice, statements, board viewing, profiles, status; coding on a phone is possible but not optimised; the interview whiteboard is hidden below 768 px.

## Elevation & Depth

Flat by default. Depth is tonal (background < surface 1 < surface 2 < surface 3) plus 1 px borders; there are no shadows on cards or buttons. One overlay shadow exists for dialogs, drawers and menus.

### Shadow Vocabulary

- **Overlay** (`box-shadow: 0 8px 24px rgb(0 0 0 / 0.35)` dark, `0 8px 24px rgb(15 17 20 / 0.12)` light): dialogs, drawers, popovers.

### Named Rules

**The Flat-By-Default Rule.** Surfaces carry no shadow at rest; only overlays float.

## Shapes

Modest rounding: 4 px for badges, 6 px for controls, 10 px for cards and dialogs. 1 px borders do the structural work; no clipping or distinctive silhouettes. Icons come from Lucide at 16 px.

## Components

### Buttons

- **Shape:** 6 px radius; heights 28 / 32 / 40 px; padding 8 / 12 / 16 px; text weight 500 at `text-14` (12.25 px rendered; `text-13`, 11.4 px, at small).
- **Primary:** Signal Violet fill, ink text; hover to the lighter violet. **Secondary** (default): surface 2 with a control-edge border; hover surface 3. **Ghost:** secondary text, surface 2 on hover. **Danger:** red fill, ink text, hover 90% opacity.
- **States:** colour transition 120 ms; disabled 50% opacity; `loading` keeps the width and shows a spinner (kept in the accessibility tree).

### Inputs / Fields

- **Style:** 32 px high, surface 1 fill, control-edge border, 6 px radius, 12 px padding; label above in 13 px secondary text.
- **Focus:** the global 2 px violet outline with offset. **Error:** border turns danger with an icon and message below.

### Tabs

- Text tabs with a 2 px underline in the accent on the active one, 1 px divider underneath, 16 px gaps; inactive text secondary, hover primary.

### Verdict Badge (signature component)

- Monospace 12 px label in a 4 px rounded box (the verdict colour at 14% as a tint on dark; a 1 px ring at 40% on light, because tinted labels fall below 4.5:1 there); failing test shown as "on test N"; `pending` pulses ("judging…"). Used in tables, the submission grid and the live board.

### Navigation

- Top bar and rail as in Layout (bottom tab bar on phones, side rail from 768 px); items are an icon with a label (hidden between 768 and 1279 px), the active one on surface 2; a command palette (⌘K) and a shortcut sheet.

### Overlays

- Radix dialog and drawer: 10 px radius (dialog) or full-height 420 px drawer, surface 1, 1 px divider border, overlay shadow, focus trapped, Esc closes.

## Do's and Don'ts

### Do:

- **Do** use only token colours; add a new colour to `tokens.css` for both themes.
- **Do** keep a text label on every verdict and every status.
- **Do** make every control keyboard-accessible with the visible 2 px focus ring, and keep targets at least 32 px on coarse pointers.
- **Do** respect `prefers-reduced-motion` (animations collapse to 0.001 ms) and keep motion functional: the judging pulse (1.2 s), the fill of a test cell (120 ms), the 1.4 s flash on a changed board row.
- **Do** keep screens working at 390 px without page-level horizontal scroll.

### Don't:

- **Don't** use gradients anywhere (Ayush's standing rule).
- **Don't** use the default Tailwind palette or hard-coded hex values outside the token files.
- **Don't** convey meaning by colour alone, or make a drag the only way to do something.
- **Don't** add decorative animation. _(inferred from the incumbent system; the redesign may revisit motion under the design skills.)_
