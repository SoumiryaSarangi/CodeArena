# Architecture decision records

Short records (context, decision, alternatives, consequences) for the locked decisions in PLAN §4.1. Changing one needs Ayush's approval and a new or superseding ADR.

- [ADR-001: Monorepo with pnpm workspaces and Turborepo](001-monorepo.md)
- [ADR-002: Web: Next.js App Router, React 19, Tailwind v4, shadcn/ui](002-web-stack.md)
- [ADR-003: API: NestJS, Drizzle ORM, PostgreSQL](003-api-stack.md)
- [ADR-004: Judge worker: Go controlling isolate 2.x](004-judge-worker.md)
- [ADR-005: Queue: Redis Streams with consumer groups, one stream per lane, XAUTOCLAIM leases](005-queue.md)
- [ADR-006: Realtime: SSE for verdicts and boards, WebSocket (Hocuspocus) for the pad](006-realtime.md)
- [ADR-007: Auth: OAuth only, short access JWT, rotating refresh cookie, realtime tickets](007-auth.md)
- [ADR-008: Contracts: Zod as source of truth, JSON Schema, Go types, CI freshness check](008-contracts.md)
- [ADR-009: Judge hosts are untrusted](009-untrusted-judge-hosts.md)
- [ADR-010: Collaboration: Yjs, y-monaco, Hocuspocus v4](010-collab.md)
- [ADR-011: Plagiarism: separate Python batch service](011-plagiarism.md)
- [ADR-012: LLM access: provider abstraction, Groq primary, Gemini fallback, one guardrail pipeline](012-llm-access.md)
- [ADR-013: Hosting: Vercel for web, Azure for Students VMs for API and judges, Terraform](013-hosting.md)
- [ADR-014: Upgrade paths documented but not built](014-upgrade-paths.md)
- [ADR-015: PostgreSQL is the source of truth; Redis is always rebuildable](015-postgres-source-of-truth.md)
