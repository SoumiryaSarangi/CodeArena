# Documentation index

Start with the [README](../README.md) for the pitch and how to run it. This folder holds everything else.

## Understand the product

| Document | What it answers |
| --- | --- |
| [PRODUCT](PRODUCT.md) | What CodeArena is, who it is for, what it does and does not do (two pages) |
| [PRD](PRD.md) | Requirements in full: personas, goals, user stories, product rules, metrics |
| [UI/UX](UI_UX.md) | Screens, copy, tokens and accessibility, with an "As built" note per card |
| [ROADMAP](ROADMAP.md) | Known limits, open follow-ups, what will not be built |

## Understand the system

| Document | What it answers |
| --- | --- |
| [ARCHITECTURE](ARCHITECTURE.md) | Components, data stores, the main flows, trust boundaries, where to look in the code |
| [SYSTEM_DESIGN](SYSTEM_DESIGN.md) | The detailed design: schemas, queue, leaderboard maths, AI budgets, security |
| [SRS](SRS.md) | Numbered requirements (`FR-…`, `NFR-…`), REST/SSE/WebSocket interfaces, error catalogue |
| [ADRs](adr/README.md) | Each decision with its alternatives and costs |
| [TESTING](TESTING.md) | The suites, what each proves, how to run them |
| [METRICS](METRICS.md) | Everything that was measured, with caveats |

## Run it

| Runbook | Use it when |
| --- | --- |
| [Contest day](runbooks/contest-day.md) | Before, during and after a contest |
| [Deploy](runbooks/deploy.md) | Releasing, rolling back |
| [Backup and restore](runbooks/backup-restore.md) | The database is lost or corrupt |
| [Collab](runbooks/collab.md) | The interview pad servers |
| [Plagiarism](runbooks/plagiarism.md) | Running and reading a plagiarism run |
| [Failure drills](runbooks/failure-drills.md) | Rehearsing faults |
| [Hibernate](runbooks/hibernate.md) | Switching the servers off to save cloud credit |
| [Revive](runbooks/revive.md) | Saving everything, deleting Azure, rebuilding later |

## Work on it

| Document | What it is |
| --- | --- |
| [PLAN](PLAN.md) | The build plan: cards, owners, order |
| [PROGRESS](PROGRESS.md) | The log: what each card built, tested and decided |
| [CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md), [CHANGELOG](../CHANGELOG.md) | Project policy files at the repository root |
| [Design](design/) | Audit, direction, round 2, captures; [design skills](design-skills.md) and [references](design-refs/README.md) |
| [DEMO](DEMO.md) | Demo-video shot list, the final numbers table, resume bullets |
| [Interview notes](interview/answers.md) | Questions and draft answers about the project |
