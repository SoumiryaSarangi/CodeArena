# Attack suite

Containment tests for the judge sandbox (J-07, FR-JUDGE-10). Each case is a small
program that tries one thing a hostile submission might do; the suite asserts the
sandbox **contains** it. The programs live in `cases/`; the runner, host-side
checks and the pass/fail logic are in `apps/worker/cmd/attack` and
`apps/worker/internal/attacksuite`.

This is defensive: every case runs inside isolate on the test machine (or a CI
runner), and each program only reports whether a blocked action was refused. No
case tries to affect anything outside its own box.

## Running

```
pnpm attack                      # all cases under tests/attack-suite
scripts/attack -v tests/attack-suite/selftest   # one directory, verbose
```

`pnpm attack` prints a table and exits non-zero if any case fails, if the run
cannot start isolate, or if there are fewer than 25 cases (the FR-JUDGE-10 floor).
Needs isolate and the language runtimes (`scripts/setup-isolate-wsl.sh`,
`scripts/setup-judge-runtimes.sh`).

## Adding a case

Create `cases/<NN-name>/` with a program `main.<ext>` and a `case.yaml`:

```yaml
title: short description of what is attempted
language: c # c | cpp17 | cpp20 | python3 | java21 | node (optional if the extension is unambiguous)
mode: run # run = execute once on `input`, inspect output; submit = judge against a trivial test
input: '' # stdin for mode run
expect:
  verdicts: [TLE, RE, AC] # the outcome must be one of these; containment, not "success", is the point
  outputLacks: [ESCAPED] # strings that must NOT appear in stdout+stderr (a blocked action leaking through)
  outputHas: [] # strings that must appear
  host: # checks the runner performs outside the box
    - no-leftover-procs # no process survives as this box's uid after the run
    - worker-alive # the runner and its parent are still running
    - env-clean # the runner's secret canary env var never appears in the output
limits: { timeMs: 1000, memMb: 256, outputKb: 64 } # optional; these are the defaults
```

### Convention for the program

Have the program attempt the action and then print a marker:

- print a line containing `BLOCKED` (optionally `BLOCKED <what>`) when the action
  was correctly refused, and list it under `outputHas` if you want to require that
  the program got far enough to try;
- print a line containing `ESCAPED <what>` if a blocked action unexpectedly
  succeeded, and list `ESCAPED` under `outputLacks` so the case fails loudly.

A case passes only when the verdict is allowed, no forbidden string appears, every
required string appears, and every host check holds.

## selftest/

Two cases the runner's own Go tests use: a clean program that must pass, and one
that prints a forbidden marker and must be reported as failing. They are not part
of the real suite (the runner is pointed at `cases/`), only proof that the harness
accepts a good outcome and rejects a bad one.
