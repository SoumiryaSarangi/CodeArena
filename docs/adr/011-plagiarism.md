# ADR-011: Plagiarism: separate Python batch service

- **Status:** Accepted (pending Ayush's review, U1.2)
- **Date:** 2026-10-05

## Context

Integrity review after contests needs structural code comparison and learned similarity, with a human making the final call.

## Decision

A Python service (`apps/plag`, managed with uv) runs after a contest: tree-sitter normalisation, winnowing fingerprints (k=12, w=8) with boilerplate removal, UniXcoder embeddings on CPU, a logistic-regression combiner tuned for precision of at least 0.9, then clustering. Results post to the admin API; an admin records a decision with a mandatory note. Signals are advisory only.

## Alternatives considered

- **Do it in TypeScript:** possible for fingerprints, but the embedding model ecosystem is Python.
- **MOSS:** external and rate-limited, and not tied to our evaluation set.

## Consequences

Best tool for the job and isolated heavy dependencies (torch, transformers). Cost: another runtime and image to build, kept out of the request path by running it as a batch.
