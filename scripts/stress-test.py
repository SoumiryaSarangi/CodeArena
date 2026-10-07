#!/usr/bin/env python3
"""Stress test for problem packages: brute force vs the reference vs every other AC solution.

    scripts/stress-test.py problems-private/                # every package that has a stress/ directory
    scripts/stress-test.py -n 1000 problems-private/ferry-pairs
    scripts/stress-test.py -j 8 --seed-base 5000 problems/hop-distances

A package opts in with:
    stress/small.py <seed>   prints ONE valid, small input for that seed (deterministic)
    stress/brute.cpp|.py     obviously-correct solution, only needs to be fast on small inputs

For seeds seed-base .. seed-base+n-1 it generates an input, REJECTS the run if validator.cpp does not
accept the input (a stress case that breaks the constraints would hide bugs), runs the brute force, solutions/main.cpp
and every other solution declared `expected: AC`, and compares their outputs token by token. On the first
mismatch it prints the seed, saves the input and the outputs to a temp directory (never into the repo), and
exits 1. Generators, brute forces and solutions are trusted repository code, so this runs on the host like
`problem-build.py`; `scripts/validate-problem` is the sandboxed check.
"""
import argparse
import concurrent.futures
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTLIB_DIR = os.path.join(ROOT, "apps", "worker", "internal", "judge", "testlib")
RUN_TIMEOUT = 20
SIZE_BUCKETS = [16, 64, 256, 1024, 4096]


class StressError(Exception):
    """The package cannot be stress tested (missing file, compile error, invalid generator output)."""


def compile_cpp(src: str, out: str, include: str = "") -> None:
    cmd = ["g++", "-O2", "-std=c++17", "-o", out, src]
    if include:
        cmd[1:1] = ["-I", include]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise StressError(f"{src} does not compile:\n{r.stderr.strip()[:2000]}")


def ac_solutions(pkg: str) -> list:
    """File names declared `expected: AC` in problem.yaml (read without a YAML library)."""
    names = []
    with open(os.path.join(pkg, "problem.yaml")) as f:
        for line in f:
            m = re.match(r"^\s*-\s*\{\s*file:\s*([^,\s]+)\s*,\s*expected:\s*AC\s*\}", line)
            if m:
                names.append(m.group(1))
    return names


def checker_kind(pkg: str) -> str:
    with open(os.path.join(pkg, "problem.yaml")) as f:
        m = re.search(r"checker:\s*\{\s*kind:\s*(\w+)", f.read())
    return m.group(1) if m else "tokens"


class Program:
    """A runnable solution: a compiled C++ binary or a Python script."""

    def __init__(self, label: str, argv: list):
        self.label, self.argv = label, argv

    def run(self, data: bytes) -> str:
        try:
            r = subprocess.run(self.argv, input=data, capture_output=True, timeout=RUN_TIMEOUT)
        except subprocess.TimeoutExpired:
            return f"<{self.label}: timed out after {RUN_TIMEOUT}s>"
        if r.returncode != 0:
            return f"<{self.label}: exit {r.returncode}: {r.stderr.decode(errors='replace').strip()[:200]}>"
        return r.stdout.decode(errors="replace")


def prepare(pkg: str, tmp: str):
    """Compiles/locates everything the stress run needs. Returns (small_py, validator, brute, solutions)."""
    stress = os.path.join(pkg, "stress")
    small = os.path.join(stress, "small.py")
    if not os.path.isfile(small):
        raise StressError(f"{pkg}: stress/small.py is missing")
    brute_src = next((os.path.join(stress, n) for n in ("brute.cpp", "brute.py") if os.path.isfile(os.path.join(stress, n))), None)
    if brute_src is None:
        raise StressError(f"{pkg}: stress/brute.cpp (or brute.py) is missing")
    validator_src = os.path.join(pkg, "validator.cpp")
    if not os.path.isfile(validator_src):
        raise StressError(f"{pkg}: validator.cpp is missing")
    kind = checker_kind(pkg)
    if kind != "tokens":
        raise StressError(f"{pkg}: stress-test compares tokens; checker kind {kind!r} is not supported yet")

    def build(src: str, label: str) -> Program:
        if src.endswith(".py"):
            return Program(label, [sys.executable, src])
        exe = os.path.join(tmp, label.replace("/", "_"))
        compile_cpp(src, exe)
        return Program(label, [exe])

    validator = os.path.join(tmp, "validator")
    compile_cpp(validator_src, validator, include=TESTLIB_DIR)
    brute = build(brute_src, "brute")
    names = ac_solutions(pkg)
    if "main.cpp" not in names:
        raise StressError(f"{pkg}: problem.yaml does not declare main.cpp as expected AC")
    solutions = [build(os.path.join(pkg, "solutions", n), n) for n in names]
    return small, validator, brute, solutions


class Result:
    def __init__(self):
        self.cases = 0
        self.programs = 0
        self.mismatch = None   # (seed, saved_dir, summary)
        self.sizes = {}        # bucket label -> count
        self.seconds = 0.0


def bucket(n: int) -> str:
    prev = 0
    for b in SIZE_BUCKETS:
        if n <= b:
            return f"{prev + 1 if prev else 0}-{b}B"
        prev = b
    return f">{SIZE_BUCKETS[-1]}B"


def run_stress(pkg: str, n: int = 1000, seed_base: int = 1, jobs: int = 4) -> Result:
    pkg = os.path.abspath(pkg)
    res = Result()
    t0 = time.time()
    tmp = tempfile.mkdtemp(prefix="stress-build-")
    try:
        small, validator, brute, solutions = prepare(pkg, tmp)
        programs = [brute] + solutions
        res.programs = len(programs)

        def one(seed: int):
            g = subprocess.run([sys.executable, small, str(seed)], capture_output=True, timeout=RUN_TIMEOUT)
            if g.returncode != 0:
                raise StressError(f"stress/small.py failed on seed {seed}: {g.stderr.decode(errors='replace').strip()[:500]}")
            data = g.stdout
            v = subprocess.run([validator], input=data, capture_output=True, timeout=RUN_TIMEOUT)
            if v.returncode != 0:
                msg = (v.stderr or v.stdout).decode(errors="replace").strip()[:500]
                raise StressError(f"stress/small.py seed {seed} produced an input the validator rejects: {msg}")
            outs = [(p.label, p.run(data).split()) for p in programs]
            expected = outs[0][1]
            bad = [(label, o) for label, o in outs[1:] if o != expected]
            return seed, data, outs, bad

        seeds = list(range(seed_base, seed_base + n))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as ex:
            for seed, data, outs, bad in ex.map(one, seeds):
                res.cases += 1
                b = bucket(len(data))
                res.sizes[b] = res.sizes.get(b, 0) + 1
                if bad and res.mismatch is None:
                    out_dir = tempfile.mkdtemp(prefix=f"stress-fail-{os.path.basename(pkg)}-")
                    with open(os.path.join(out_dir, f"seed-{seed}.in"), "wb") as f:
                        f.write(data)
                    for label, o in outs:
                        with open(os.path.join(out_dir, f"seed-{seed}.{label}.out"), "w") as f:
                            f.write(" ".join(o) + "\n")
                    summary = "; ".join(f"{label}={' '.join(o)[:60]!r}" for label, o in outs)
                    res.mismatch = (seed, out_dir, summary)
                    break
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        res.seconds = time.time() - t0
    return res


def find_packages(arg: str) -> list:
    if os.path.isfile(os.path.join(arg, "problem.yaml")):
        return [arg]
    out = []
    for name in sorted(os.listdir(arg)):
        p = os.path.join(arg, name)
        if os.path.isfile(os.path.join(p, "problem.yaml")):
            out.append(p)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Brute force vs reference vs alternatives on small random inputs.")
    ap.add_argument("targets", nargs="+", help="a package directory, or a directory of packages")
    ap.add_argument("-n", type=int, default=1000, help="cases per package (default 1000)")
    ap.add_argument("--seed-base", type=int, default=1, help="first seed (default 1)")
    ap.add_argument("-j", type=int, default=max(1, min(8, os.cpu_count() or 1)), help="parallel cases")
    args = ap.parse_args(argv)

    failed = 0
    ran = 0
    for target in args.targets:
        explicit = os.path.isfile(os.path.join(target, "problem.yaml"))
        for pkg in find_packages(target):
            name = os.path.basename(os.path.abspath(pkg))
            if not explicit and not os.path.isdir(os.path.join(pkg, "stress")):
                print(f"skip  {name}: no stress/ directory")
                continue
            ran += 1
            try:
                r = run_stress(pkg, args.n, args.seed_base, args.j)
            except StressError as e:
                failed += 1
                print(f"ERROR {name}: {e}")
                continue
            hist = "  ".join(f"{k}:{v}" for k, v in sorted(r.sizes.items(), key=lambda kv: (len(kv[0]), kv[0])))
            if r.mismatch:
                failed += 1
                seed, out_dir, summary = r.mismatch
                print(f"FAIL  {name}: mismatch on seed {seed} after {r.cases} cases\n        {summary}\n        saved: {out_dir}")
            else:
                print(f"ok    {name:<20} {r.cases} cases x {r.programs} programs in {r.seconds:.1f}s   input sizes  {hist}")
    if ran == 0 and not failed:
        print("no package with a stress/ directory was found", file=sys.stderr)
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
