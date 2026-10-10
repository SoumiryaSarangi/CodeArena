# ADR-007: Auth: OAuth only, short access JWT, rotating refresh cookie, realtime tickets

- **Status:** Accepted (approved by Soumirya, 2026-10-05)
- **Date:** 2026-10-05

## Context

Users are students who all have Google accounts; storing passwords would add risk and work with no benefit. SSE and WebSocket cannot send bearer headers, and putting a long-lived token in a URL leaks it into logs.

## Decision

Google and GitHub OAuth 2.0 with PKCE and state (FR-AUTH-01). Access token: ES256 JWT, 15 minutes, sent as `Authorization: Bearer` (so it is not ambient and CSRF cannot ride on it). Refresh token: 30-day sliding, httpOnly, Secure, SameSite=Lax cookie scoped to `/api/auth`, stored hashed, rotated on every use; presenting an already-rotated token revokes its whole family (FR-AUTH-05). Mutations also need a double-submit CSRF token. Realtime uses `POST /realtime/ticket`: a 60-second single-use ticket (`GETDEL` in Redis) bound to user and topics, accepted in the SSE or WebSocket URL.

## Alternatives considered

- **Email and password:** more attack surface (hashing, reset flows, breach handling).
- **Session cookies only:** simple, but harder to use across Vercel and the API origin and more CSRF-exposed.
- **Long-lived JWT in the URL for SSE:** leaks into logs and history.

## Consequences

No password storage and a small blast radius for stolen tokens. Cost: depends on two OAuth providers, and the refresh rotation logic needs careful tests (reuse detection, concurrency).
