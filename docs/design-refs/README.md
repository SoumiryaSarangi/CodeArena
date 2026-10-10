# Design references (UI-08)

Measurements of two public marketing pages, taken on 2026-10-10 with the `taste` extractor at 1440×900 (Linear's and Vercel's public home pages, signed out). They are **references for study, not assets**: no screenshots, logos, copy or code from those sites are kept here, and nothing is to be copied. Raw numbers only; the analysis lives in `docs/design/DIRECTION.md`.

| | linear.app | vercel.com |
|---|---|---|
| Surface | dark, `rgb(8,9,10)` page, `rgb(15,16,17)` panels | light, `rgb(250,250,250)` page, white panels |
| Type | Inter Variable + Berkeley Mono | Geist Sans + Geist Mono |
| Hero h1 | 64 px / weight 510 / line-height 1.0 / tracking −1.4 px | 64 px / weight 400 / line-height 1.0 / tracking −3.8 px |
| h2, h3 | 48 px, 20 px | 56 px (h2) |
| Body | 15 px / 24 px | 14 px / 20 px |
| Most-used sizes | 12 (186), 14 (180), 13 (120), 15 (65) | 14 (127), 12 (12), 24 (9) |
| Weights | 400, 510, 590 (variable-font steps, not 400/500/600/700) | 400, 450, 500 |
| Text colours | grey ladder `138,143,152` / `98,102,109` / `208,214,224`, one pink accent | `77,77,77` and `23,23,23`, almost no colour |
| Radii | 9999, 8, 4, 12 | pill, 6 |
| Spacing steps | 8, 4, 6, 12 | 2, 6, 12 |
| Colour use | neutral first, colour only for state | neutral only; black is the brand |

What the numbers say that matters to CodeArena: both pages set **large display type against small, calm body text** (a 4× jump from body to hero, where CodeArena's biggest heading is 1.7× its body); both put **colour only where it means something**; both use tight negative tracking on display sizes and hairline borders instead of shadows. Both pages also use gradients or glows in places; **CodeArena does not** (rule fixed by Ayush).

## Round 2 (UI-15, 2026-10-10)

The `taste` extractor was run again through the repository's Chromium at 1440×900, signed out, on the three sites the card named:

| Site | Result |
|---|---|
| leetcode.com/problemset/ | **Blocked by the site** (HTTP 403 "Just a moment…", a bot check). Skipped; no workaround attempted. Not measured. |
| codeforces.com/contests | **Blocked by the site** (the same 403 bot check). Skipped; no workaround attempted. Not measured. |
| linear.app | Measured; the numbers are the same as in the table above (h1 64 px / 510, h2 48 px, body 15 px, Inter Variable + Berkeley Mono, page `rgb(8,9,10)`, 12 and 14 px the most used sizes, radii 9999 / 8 / 4 px, 1 px ring shadows). |

So the LeetCode and Codeforces feel (dense, fast, familiar) is taken from the owner's brief and the critique of the built screens, not from measurements of those sites. If numbers are wanted later, they can be taken by hand in a normal browser and added here.
