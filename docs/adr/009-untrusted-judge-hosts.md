# ADR-009: Judge hosts are untrusted

- **Status:** Accepted (pending Ayush's review, U1.2)
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
