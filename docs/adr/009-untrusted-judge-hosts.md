# ADR-009: Judge hosts are untrusted

- **Status:** Accepted (approved by Ayush, 2026-10-05)
- **Date:** 2026-10-05

## Context

The judge runs arbitrary user code. If a sandbox escape happens, the attacker should gain nothing valuable. Judge0's CVEs (symlink file read, SSRF to internal services) show the realistic failure modes.

## Decision

Judge workers run on separate VMs and hold no database credentials. They connect to Redis as ACL user `judge`, which may only `XREADGROUP/XACK/XCLAIM/XAUTOCLAIM` on `jobs:*`, `XADD` on `results`, `PUBLISH` on `progress:*` and `SET` on `hb:*`, and read object storage with a read-only key. Network egress from judge VMs is limited to Redis and storage private addresses. The API validates every result against the schema and ignores results for unknown run versions. The host never performs file operations on paths inside a box. An attack suite (symlinks, fork bombs, memory bombs, network, /proc and environment probes) runs in CI and nightly on the judge VM.

## Alternatives considered

- **Trust the judge host:** simpler wiring, but a single escape would expose the database.
- **gVisor or Firecracker per job:** stronger isolation, deferred to ADR-014 because of cost and complexity.

## Consequences

A compromised judge can at worst forge results for jobs it was given, which schema checks and run-version checks limit. Cost: extra operational setup (ACLs, firewall rules, a second credential set).

## Hardening from the attack suite (J-07/J-08, 2026-10-06)

The attack suite (`tests/attack-suite`, 28 cases written by Ayush, FR-JUDGE-10) runs every case in a real box and checks the outcome plus host-side facts (no box process survives, the worker stays alive, a secret in the worker's environment never reaches the output). The first run passed 27 of 28. What it showed, and what changed:

- **Boxes saw the host's whole `/dev`.** isolate's default rules bind the host `/dev` into each box with device access: about 200 nodes, including disks, `/dev/mem`, `/dev/kmsg`, `/dev/kvm`, `/dev/fuse` and `/dev/userfaultfd`. Only file permissions kept most of them closed, and `/dev/kmsg` was readable on the dev machine. **Fix:** every run (compile, run, checker) now deletes the default rule (`--dir=dev=`) and binds a prepared directory instead (`--dir=dev=/var/local/lib/codearena/box-dev:dev`) holding only `null`, `zero`, `full`, `random`, `urandom`, the `fd`/`stdin`/`stdout`/`stderr` symlinks into `/proc/self/fd`, and an empty `shm/` where isolate mounts a private, memory-accounted tmpfs. `scripts/setup-isolate-wsl.sh` and the judge cloud-init create it; the worker refuses to start if `null` there is not a character device. A test asserts the exact `/dev` listing inside a box.
- **Kernel log.** `kernel.dmesg_restrict = 1` is set (`/etc/sysctl.d/60-codearena-judge.conf`) as defence in depth, since the box no longer has `/dev/kmsg` at all.
- **Environment.** A box's environment is `PATH=/usr/bin:/bin` plus isolate's built-in `LIBC_FATAL_STDERR_=1`, for the compile step as well as runs (both tested), and the worker execs isolate with an empty environment, so worker secrets cannot leak through it.
- **Special files.** isolate 2.7 deletes symlinks, FIFOs and other non-regular files from a box after each run; the host's safe reader (`O_NOFOLLOW`, `fstat`, size cap) is the second layer and is unit-tested on its own.
- **Non-root worker.** The worker refuses to run as root unless `WORKER_ALLOW_ROOT=1`; on the judge VM it runs as the no-login system user `codearena-judge`. isolate is setuid, so the worker never needs root, and an escape into the worker process does not yield root.
- **Compile step.** Capped like a run: 10 s CPU, 31 s wall, 512 MB, 64 processes, 64 MB per file, 64 open files, same minimal `/dev` and environment (pinned by a test). `#include` of host files and of `/dev/urandom`, template recursion and oversized sources all end as CE in the suite.
- **What held without changes:** process, memory, CPU, wall-time, disk and output limits; no network (IPv4, IPv6, DNS); no other box or host isolate paths; no `ptrace`, `setuid`, raw sockets, `mount` or `chroot`; zombies and stray children gone after teardown; signals cannot reach the worker.

Residual risk: the kernel itself is shared; a kernel exploit from inside a box remains the main escape route. That is why the judge VM holds no secrets (this ADR's main decision) and why ADR-014 keeps gVisor/Firecracker as the next step if the threat grows.
