# ADR-008: Contracts: Zod as source of truth, JSON Schema, Go types, CI freshness check

- **Status:** Accepted (pending Ayush's review, U1.2)
- **Date:** 2026-10-05

## Context

The web app, the API and the Go worker exchange `JudgeJob`, `JudgeProgress`, `JudgeResult` and REST/SSE payloads. Hand-maintained copies in three places would drift.

## Decision

Zod schemas in `packages/contracts` are the source. `pnpm contracts:gen` writes JSON Schema (Zod's built-in `z.toJSONSchema`) to `packages/contracts/generated/json-schema` and Go structs (via `quicktype-core`, pinned) to `apps/worker/internal/contracts/contracts.gen.go`, normalising constant names to `<Type><Value>`. Generated files are committed so the Go worker builds without Node. `pnpm contracts:check` regenerates in memory and byte-compares; it runs in `pnpm check`, as a vitest test and in the contracts GitHub workflow, so changing a Zod field without regenerating fails CI. A Go test round-trips the same JSON fixtures the TypeScript tests use. Timestamps on the wire are epoch milliseconds; the checker is a flat object with refinements so Go gets one clean struct.

## Alternatives considered

- **OpenAPI or protobuf first:** strong tooling, but a second schema language beside Zod, which already validates every API boundary.
- **Hand-written Go types with tests:** cheap, but drift is only caught if someone writes the test.
- **Generating Go at build time only:** keeps the repo smaller, but the worker could no longer build without Node.

## Consequences

Frontend, API and worker cannot disagree silently. Cost: generated files appear in diffs, and quicktype's naming needs post-processing.
