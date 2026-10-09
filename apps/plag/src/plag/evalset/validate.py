"""Checks a generated "independent solution" against the problem's own tests before it is used as a negative.

An independent solution that does not solve the problem would be a different kind of negative (nonsense, not
"another student's attempt"), so only programs that compile and pass every test are kept. Problems whose checker is a
testlib program cannot be compared token by token; for those a program only has to run on every test without error.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import yaml_lite


@dataclass(frozen=True)
class Verdict:
    ok: bool
    reason: str


def _checker(problem_dir: Path) -> tuple[str, float]:
    meta = yaml_lite.load(problem_dir / "problem.yaml")
    c = meta.get("checker", {})
    return str(c.get("kind", "tokens")), float(c.get("eps", 0.0) or 0.0)


def _same(kind: str, eps: float, got: str, want: str) -> bool:
    if kind == "testlib":
        return True  # cannot be compared without the checker: running without error is all that is asked
    g, w = got.split(), want.split()
    if len(g) != len(w):
        return False
    for a, b in zip(g, w, strict=True):
        if kind == "float":
            try:
                if abs(float(a) - float(b)) > eps * max(1.0, abs(float(b))):
                    return False
            except ValueError:
                return False
        elif a != b:
            return False
    return True


def check(problem_dir: Path, language: str, source: str, timeout: float = 10.0) -> Verdict:
    """Compiles (C++) and runs the program on every test of the problem."""
    kind, eps = _checker(problem_dir)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        if language.startswith("cpp"):
            (work / "a.cpp").write_text(source)
            cc = subprocess.run(
                ["g++", "-O2", "-std=c++17", "-o", str(work / "a.out"), str(work / "a.cpp")],
                capture_output=True, text=True, timeout=120,
            )  # fmt: skip
            if cc.returncode != 0:
                return Verdict(False, "does not compile")
            cmd = [str(work / "a.out")]
        else:
            (work / "a.py").write_text(source)
            cmd = [sys.executable, "-I", str(work / "a.py")]
        tests = sorted((problem_dir / "tests").glob("*.in"))
        if not tests:
            return Verdict(False, "the problem has no tests")
        for t in tests:
            try:
                run = subprocess.run(cmd, input=t.read_text(), capture_output=True, text=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                return Verdict(False, f"too slow on {t.name}")
            if run.returncode != 0:
                return Verdict(False, f"crashes on {t.name}")
            if not _same(kind, eps, run.stdout, t.with_suffix(".ans").read_text()):
                return Verdict(False, f"wrong answer on {t.name}")
    return Verdict(True, "passes every test")
