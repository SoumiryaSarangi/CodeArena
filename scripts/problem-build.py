#!/usr/bin/env python3
"""Regenerates a problem package's tests from its generator and reference solution.

    scripts/problem-build.py problems/range-sums     # one package
    scripts/problem-build.py problems/               # every package under problems/

For each package: runs generators/gen.py (writes tests/NN.in; it must be deterministic,
seed every random choice), compiles solutions/main.cpp with g++ and runs it on every input to
write tests/NN.ans. Generators and the reference are trusted repository code, so this runs on
the host; `scripts/validate-problem` then re-checks everything independently in the judge's
sandbox (including a second, differently written AC solution).
"""
import os
import shutil
import subprocess
import sys
import tempfile


def build(pkg: str) -> None:
    pkg = os.path.abspath(pkg)
    gen = os.path.join(pkg, "generators", "gen.py")
    ref = os.path.join(pkg, "solutions", "main.cpp")
    for f in (gen, ref):
        if not os.path.isfile(f):
            sys.exit(f"{pkg}: {f} is missing")
    tests = os.path.join(pkg, "tests")
    shutil.rmtree(tests, ignore_errors=True)
    os.makedirs(tests)
    subprocess.run([sys.executable, gen], cwd=pkg, check=True)
    inputs = sorted(f for f in os.listdir(tests) if f.endswith(".in"))
    if not inputs:
        sys.exit(f"{pkg}: the generator wrote no tests")
    with tempfile.TemporaryDirectory() as tmp:
        exe = os.path.join(tmp, "ref")
        subprocess.run(["g++", "-O2", "-std=c++17", "-o", exe, ref], check=True)
        for name in inputs:
            with open(os.path.join(tests, name), "rb") as fin, \
                 open(os.path.join(tests, name[:-3] + ".ans"), "wb") as fout:
                subprocess.run([exe], stdin=fin, stdout=fout, check=True, timeout=20)
    size = sum(os.path.getsize(os.path.join(tests, f)) for f in os.listdir(tests))
    print(f"built {os.path.basename(pkg)}: {len(inputs)} tests, {size / 1024:.0f} KB")


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for arg in sys.argv[1:]:
        if os.path.isfile(os.path.join(arg, "problem.yaml")):
            build(arg)
        else:
            for name in sorted(os.listdir(arg)):
                p = os.path.join(arg, name)
                if os.path.isfile(os.path.join(p, "problem.yaml")):
                    build(p)


if __name__ == "__main__":
    main()
