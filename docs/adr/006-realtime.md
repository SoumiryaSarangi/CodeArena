# ADR-006: Realtime: SSE for verdicts and boards, WebSocket (Hocuspocus) for the pad

- **Status:** Accepted (pending Ayush's review, U1.2)
- **Date:** 2026-10-05

## Context

Verdicts, leaderboards, clarifications and announcements are one-way server pushes. The interview pad is a bidirectional, high-frequency CRDT sync.

## Decision

Server-Sent Events over HTTP/2 for all one-way streams, one `EventSource` per tab carrying many topics, resume through `Last-Event-ID` against a Redis replay stream, heartbeats every 15 s, and a 256 KB per-connection buffer cap (SD-§10). Hocuspocus WebSocket for the pad only. Redis pub/sub fans events out across API instances. Both transports authenticate with single-use realtime tickets (ADR-007) because `EventSource` and the WebSocket handshake cannot send an `Authorization` header.

## Alternatives considered

- **WebSocket everywhere:** one transport, but reconnect, resume and proxy behaviour are more work for one-way data.
- **Polling:** simplest, but too slow and too heavy for a live scoreboard.
- **Socket.IO:** convenient, but adds a protocol and sticky-session needs we do not otherwise have.

## Consequences

The simplest correct transport per use case, and SSE passes through Caddy and Vercel cleanly. Cost: two realtime stacks to operate, and SSE requires HTTP/2 to avoid the browser's six-connection limit.
