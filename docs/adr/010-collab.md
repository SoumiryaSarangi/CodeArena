# ADR-010: Collaboration: Yjs, y-monaco, Hocuspocus v4

- **Status:** Accepted (pending Ayush's review, U1.2)
- **Date:** 2026-10-05

## Context

The interview pad needs real-time shared code and a whiteboard, conflict-free under reconnects, with playback and restore, for a small number of users per room.

## Decision

One Yjs document per room (`room:{roomId}`, `gc: false` for snapshots, 90-minute session cap, 2 MB doc cap) holding the code text, metadata and whiteboard strokes. Hocuspocus v4 (MIT, Node 22+) provides auth, persistence and hooks; `onAuthenticate` verifies a ticket with the API and sets read-only for observers, and `beforeHandleAwareness` overwrites each awareness `user` with the server-verified identity so clients cannot spoof it. Updates and periodic checkpoints go to Postgres for playback. Interviewer notes are an API resource, never part of the document. Two collab instances use the Redis extension for availability; Caddy routes `/collab/{roomId}` by URI hash so a room normally lives on one instance.

## Alternatives considered

- **Operational transform (ShareDB):** mature, but needs a central transform server and harder offline merging.
- **Liveblocks or a hosted service:** quick, but costs money and hides the mechanics.
- **y-redis:** scales further, but AGPL-licensed and unnecessary at this size.

## Consequences

Stateless relays and offline-tolerant merging. Cost: the Redis extension gives availability, not CPU scaling, since every instance holding a document processes its messages.
