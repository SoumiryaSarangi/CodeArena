# ADR-004: Judge worker: Go controlling isolate 2.x

- **Status:** Accepted (approved by Soumirya, 2026-10-05)
- **Date:** 2026-10-05

## Context

Judging must be safe against hostile code, accurate in timing, and concurrent across cores. The worker is a small, long-running systems service that spawns and supervises sandboxes.

## Decision

A Go worker drives `isolate` 2.x in cgroup v2 mode (`--cg`): one box per core, pinned with `taskset`; CPU time, wall time, memory, process, file-size, stack and open-file limits; no network; empty environment except `PATH`; compilation sandboxed too (SD-§8). Outputs are read with `O_NOFOLLOW`, `fstat` and a size cap, never by following paths inside a box. isolate is not packaged for Ubuntu 24.04, so it is built from a pinned tag (v2.7) with its commit SHA verified (`scripts/setup-isolate-wsl.sh`).

## Alternatives considered

- **Judge0:** ready-made, but its sandbox CVEs (symlink escape, SSRF) are exactly the class we want to design out, and we would not learn the internals.
- **Docker per submission:** easy isolation, but slow start-up and poor, noisy timing.
- **nsjail / bubblewrap:** capable, but isolate is purpose-built for contests and gives per-group CPU accounting through cgroups.
- **Node or Python worker:** quicker to write, but process control and concurrency are cleaner in Go.

## Consequences

Contest-grade accounting and a small trusted code base. Cost: isolate needs root-capable setup (systemd, cgroup v2), so judge hosts are Linux VMs and WSL2 needs systemd enabled.
