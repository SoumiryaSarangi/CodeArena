# Practice problem packages

Twenty original, textbook-style problems used as fixtures for the judge (J-06) and as the first practice set. Each directory is a package in the SRS §3.1.6 format:

```
<slug>/
  problem.yaml      title, rating, practicePoints (= rating/100), tags, limits, checker, samples, avoidSet, solutions
  statement.md      sections Input, Output, Notes (Markdown + KaTeX)
  editorial.md      key ideas (grounds the AI Coach)
  validator.cpp     testlib validator, run on every test input
  checker.cpp       only for checker kind testlib
  generators/gen.py deterministic test generator (every random choice is seeded)
  solutions/        main.cpp (reference), alt.py (an independently written AC solution),
                    wa-*.cpp, tle-*.cpp, re-crash.cpp, mle-hog.cpp, ole-flood.cpp, each with its expected verdict
  tests/NN.in .ans  generated, committed (samples are the first tests)
```

## Commands

```
scripts/problem-build.py problems/            # regenerate tests: gen.py, then main.cpp writes the .ans files
scripts/validate-problem problems/            # structure + validator on every input + every solution vs its expected verdict
scripts/validate-problem -v -j 4 problems/x   # one package, per-solution lines, 4 cores
scripts/validate-problem -tar /tmp/x.tar problems/x   # the testset archive the judge fetches, prints its SHA-256
pnpm problem:import --publish problems/       # structure check + upload tests to S3 + create/refresh versions (P-01); omit --publish to keep them private
```

`problem:import` is idempotent: identical content prints `unchanged`; a changed statement, test, limit, checker, tag or solution creates the next immutable version (FR-PROB-02). It checks structure only; run `problems:validate` first, because the judge is what runs the solutions (FR-PROB-04).

`validate-problem` runs through the real judge engine in isolate boxes (needs `scripts/setup-isolate-wsl.sh` and `scripts/setup-judge-runtimes.sh`). Structure alone is also checked in plain `go test ./...` (`TestRepositoryProblems`).

## Stress testing (P-02)

`validate-problem` proves the declared solutions get their expected verdicts on the committed tests. A **stress test** goes further: it asks whether the reference itself is right, by comparing it with an obviously-correct brute force on thousands of small random inputs.

```
scripts/stress-test.py problems-private/                  # every package that has a stress/ directory, 1000 cases each
scripts/stress-test.py -n 5000 -j 8 problems-private/ferry-pairs
pnpm problems:stress problems-private/                    # the same through pnpm
python3 -m unittest scripts/tests/test_stress.py          # tests of the tool itself (needs g++)
```

A package opts in with two files:

```
stress/small.py     `small.py <seed>` prints ONE valid, small input (deterministic per seed; vary size and edge values)
stress/brute.cpp    exhaustive solution that is obviously correct (subsets, all paths, all splits); .py also works
```

For every seed the tool runs `small.py`, **fails the package if `validator.cpp` rejects the input** (a case that breaks the constraints would hide bugs), runs the brute force, `solutions/main.cpp` and every other solution declared `expected: AC`, and compares outputs token by token. The first mismatch prints the seed and saves the input and every program's output to a temp directory, never into the repository. Only `checker: tokens` packages are supported. It runs trusted package code on the host, like `problem-build.py`.

Brute forces should use a *different method* from the reference (for example, enumerate all subsets rather than sort and prefix-sum). Keep inputs tiny (n up to about 12) so exhaustive search is instant, and make `small.py` cover zeros, ties and extremes, because large-value overflows are caught by the large tests and the independent AC solutions in `validate-problem`, not here.

## Conventions

- Every package has an AC reference in C++ and an AC solution in Python written a different way, so a wrong reference cannot hide: the two must agree on every test.
- Wrong solutions are realistic mistakes (overflow, off-by-one, wrong greedy, ignoring ties), not noise, and the tests are built to catch them. Time-limit solutions are the naive algorithm and must run well over the limit on the large tests (checked: at least 2x). `re-crash`, `mle-hog` and `ole-flood` are the same in every package.
- Time limits are tight on purpose (250 to 1000 ms): reference solutions finish in tens of milliseconds, so a slow algorithm is separated from a fast one by a wide margin.
- Test data stays small (about 23 MB for all twenty) by using short numbers where the point is the algorithm, and long ones only where the point is overflow.

## Problems

| Rating | Package | Title | Tags | Checker | Time limit (ms) | Tests |
|---:|---|---|---|---|---:|---:|
| 800 | `peak-reading` | Peak Reading | implementation, arrays | tokens | 500 | 10 |
| 800 | `sum-two-numbers` | Two Numbers, One Total | implementation, math | tokens | 1000 | 12 |
| 900 | `rainfall-totals` | Rainfall Totals | prefix sums, arrays | tokens | 250 | 8 |
| 900 | `unique-badges` | Unique Badges | sorting, sets | tokens | 500 | 10 |
| 1000 | `shelf-search` | Shelf Search | binary search, arrays | tokens | 250 | 9 |
| 1100 | `budget-windows` | Budget Windows | two pointers, arrays | tokens | 250 | 10 |
| 1100 | `hall-of-fame` | Hall of Fame | sorting | exact | 500 | 8 |
| 1200 | `matching-pair` | Matching Pair | hashing, two pointers, checker | testlib | 250 | 11 |
| 1200 | `maze-runner` | Maze Runner | bfs, graphs, grids | tokens | 500 | 11 |
| 1200 | `stair-climb` | Stair Climb | dp, counting | tokens | 500 | 12 |
| 1300 | `hop-distances` | Hop Distances | bfs, graphs | tokens | 500 | 10 |
| 1300 | `network-islands` | Network Islands | dsu, graphs | tokens | 500 | 8 |
| 1400 | `divisor-census` | Divisor Census | number theory, sieve | tokens | 1000 | 11 |
| 1400 | `packing-the-van` | Packing the Van | dp, knapsack | tokens | 1000 | 12 |
| 1500 | `cheapest-route` | Cheapest Route | dijkstra, shortest paths, graphs | tokens | 500 | 10 |
| 1500 | `fractional-loot` | Fractional Loot | greedy, sorting, floating point | float (eps 1e-06) | 250 | 9 |
| 1500 | `rising-subsequence` | Rising Subsequence | dp, binary search, lis | tokens | 500 | 10 |
| 1500 | `room-booking` | Room Booking | greedy, sorting, intervals | tokens | 250 | 11 |
| 1600 | `spell-fixer` | Spell Fixer | dp, strings | tokens | 1000 | 13 |
| 1700 | `needle-in-text` | Needle in Text | strings, kmp | tokens | 500 | 13 |
