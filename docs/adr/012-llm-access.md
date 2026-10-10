# ADR-012: LLM access: provider abstraction, Groq primary, Gemini fallback, one guardrail pipeline

- **Status:** Accepted (approved by Soumirya, 2026-10-05)
- **Date:** 2026-10-05

## Context

The AI Coach (hints, reviews, room summaries) must be free to run, fast, and not dependent on a single provider's quota.

## Decision

A provider router exposes `complete({task, messages, maxTokens, temperature})` and chooses a model chain per task (SD-§12.1): Groq models first, Gemini Flash as fallback. Before each call a daily token and request budget in Redis (`ai:budget:{model}:{day}`) is checked and the router moves on if exhausted, honouring `retry-after`. All AI features share one guardrail pipeline: untrusted user code is delimited, a sufficiency step and an independent code-removal pass run, and a deterministic filter blocks solution leaks. Hints are disabled inside contests (FR-AI rules).

## Alternatives considered

- **A single paid provider:** simpler and better quality, but costs money and creates a single point of failure.
- **Self-hosted small model:** private, but needs GPU or slow CPU inference we do not have.

## Consequences

Free and resilient to a provider outage. Cost: model quality varies by task and free-tier limits change, so budgets and an evaluation harness (AI-04) are part of the design.
