# ADR-009: Judge hosts are untrusted

- **Status:** Accepted (approved by Ayush, 2026-10-05)
- **Date:** 2026-10-05

## Context

The judge runs arbitrary user code. If a sandbox escape happens, the attacker should gain nothing valuable. Judge0's CVEs (symlink file read, SSRF to internal services) show the realistic failure modes.

## Decision

Judge workers run on separate VMs and hold no database credentials. They connect to Redis as ACL user `judge`, which may only `XREADGROUP/XACK/XCLAIM/XAUTOCLAIM/XPENDING/XDEL/XRANGE/XGROUP CREATE` on `jobs:*` (plus `XADD` on `jobs:dlq` and `jobs:quarantine`, and `HINCRBY/HGET/HDEL` on the crash counter `jobs:crashes`), `XADD` on `results`, `PUBLISH` on `progress:*`, and `SET` and `EXISTS` on `hb:*` (Q-02 added `XPENDING`, the crash counter and `EXISTS hb:*`), and read object storage with a read-only key. Network egress from judge VMs is limited to Redis and storage private addresses. The API validates every result against the schema and ignores results for unknown run versions. The host never performs file operations on paths inside a box. An attack suite (symlinks, fork bombs, memory bombs, network, /proc and environment probes) runs in CI and nightly on the judge VM.

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

**API-side Redis permissions (for Q-04's `api` ACL user).** Besides enqueueing (`EVAL` on `seq:*` and `jobs:*`), the verdict consumer needs `XGROUP CREATE`, `XREADGROUP`, `XACK`, `XAUTOCLAIM`, `XPENDING`, `XINFO GROUPS` and `XTRIM` on `results`; `XADD` on `results:dlq`; and `XADD`, `EXPIRE` and `PUBLISH` on `evt:*` and `rt:*`.

## Redis users as built (Q-04, 2026-10-06)

`infra/redis/users.acl.tmpl` defines the users (explained in `infra/redis/README.md`): `default` is off; `admin` (operations only); `api` (all keys and channels, but not the `@dangerous` and `@admin` commands, so no `FLUSHALL`, `KEYS`, `CONFIG`, `ACL`, `SHUTDOWN`, `MONITOR`...); and `judge`, whose selectors grant each command only on its own keys. Notable consequences: the judge can neither read nor enumerate any other key, cannot add a job to a lane (it may `XADD` only to `jobs:dlq` and `jobs:quarantine`), cannot read `results`, and cannot publish to `rt:*`. Tests start a Redis from this exact file and entrypoint: the real worker runs as `judge` (claims, leases, takeover, quarantine, dead letters, transactions all work) with a log check that no command was refused, and a matrix of 37 forbidden commands is refused; the API's enqueue script and verdict consumer run as `api` while 10 destructive commands are refused. Mutating the file (widening the judge, removing `XPENDING`, letting it `XADD` any lane, un-restricting `api`) each fails a test.

Operational notes: (1) after any change run `docker compose up -d --force-recreate redis`; a dev Redis created before Q-04 has the old, narrower `judge` rules and will refuse the worker's `XPENDING`, `MULTI` and crash-counter commands. (2) The API's dev default `REDIS_URL` still uses `admin` for convenience; production must set the `api` user. (3) Residual power of a compromised judge: it can acknowledge or delete jobs it can see (the reconciler re-enqueues them), post wrong results for jobs it was given (schema and run-version checks limit this), and fake heartbeats.

