# Security policy

CodeArena runs code written by strangers, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Use one of these private routes:

- GitHub: the repository's **Security → Report a vulnerability** form (private advisory), or
- e-mail: **soumiryasarangi@gmail.com**, with the subject "CodeArena security".

Include what you found, the steps to reproduce it, what you think the impact is, and (if you want credit) how to
name you. A proof of concept against **your own account and your own data** is enough: please do not read, change or
delete anyone else's data, and do not run load against the live site.

You can expect an acknowledgement within a few days. This is a student project run by one person, so there is no
bounty and no fixed fix time, but confirmed issues are fixed, recorded in
[`docs/PROGRESS.md`](docs/PROGRESS.md) and credited if you wish.

## Scope

In scope: the web app, the API, the judge worker and its sandbox, the interview pad (collab server), the
plagiarism service, authentication and sessions, and the deployment files in this repository.

Particularly interesting: a sandbox escape or a way for a submission to read another submission's files or hidden
tests; reaching Redis or Postgres from a judge host; reading another user's private code, interviewer notes or
AI summary; forging a verdict; impersonating someone in the pad; bypassing the owner/admin checks.

Out of scope: denial of service by volume, social engineering, findings that need a compromised browser or
operating system, and issues in third-party services (Vercel, Azure, Google, GitHub, Groq, Gemini).

## Supported versions

Only the current `main` branch (the deployed version) is supported.

## How the system is designed to resist attack

The threat model and controls are in [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) (security section),
[ADR-009 untrusted judge hosts](docs/adr/009-untrusted-judge-hosts.md), [ADR-007 auth](docs/adr/007-auth.md) and the
summary in the [README](README.md#security). A 28-program attack suite
([`tests/attack-suite`](tests/attack-suite)) runs nightly against a real judge VM.

## Secrets

Secrets are never committed: only `.env.example` files are. If you find a secret in this repository or its history,
please report it privately as above.
