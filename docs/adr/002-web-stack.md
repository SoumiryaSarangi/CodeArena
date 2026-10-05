# ADR-002: Web: Next.js App Router, React 19, Tailwind v4, shadcn/ui

- **Status:** Accepted (pending Ayush's review, U1.2)
- **Date:** 2026-10-05

## Context

The product needs server-rendered public pages (problems, profiles, leaderboards) and a highly interactive app (editor, live verdicts, pad). Ayush already knows this stack from a previous project, so there is no learning cost during a two-week build.

## Decision

Next.js (App Router) with React 19 and TypeScript, Tailwind CSS v4 for styling through design tokens (UI_UX §5.1), and shadcn/ui (Radix) components restyled to those tokens. Hosted on Vercel (ADR-013). Server state through TanStack Query, client state through Zustand, realtime through SSE (ADR-006).

## Alternatives considered

- **Vite SPA:** simpler, but no server rendering for public pages and no free Vercel preview flow for them.
- **Remix / SvelteKit:** good frameworks, but new to the builder.
- **A component library (MUI, Chakra):** faster to start, but harder to hold to the strict token-only rule.

## Consequences

Fast to build and well documented. Cost: App Router caching rules are subtle, so authenticated data is fetched client-side through the API rather than relying on Next's caches.
