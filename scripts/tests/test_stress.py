"""Tests for scripts/stress-test.py (P-02; FR-PROB-04: a package's solutions are checked against each other, so a wrong reference cannot hide). Run: python3 -m unittest scripts/tests/test_stress.py
Needs g++ (same as problem-build.py). Each test builds a tiny synthetic package in a temp directory."""
import importlib.util
import io
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("stress_test", os.path.join(HERE, "..", "stress-test.py"))
st = importlib.util.module_from_spec(spec)
spec.loader.exec_module(st)

VALIDATOR = r"""#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    inf.readInt(1, 1000, "a"); inf.readSpace(); inf.readInt(1, 1000, "b"); inf.readEoln(); inf.readEof();
}
"""
ADD = "#include <cstdio>\nint main(){int a,b;if(scanf(\"%d %d\",&a,&b)!=2)return 1;printf(\"%d\\n\",a+b);}\n"
ADD_OFF_BY_ONE = ADD.replace("a+b", "a+b+(a==b)")
ADD_PY = "a,b=map(int,input().split())\nprint(a+b)\n"
ADD_PY_WRONG = "a,b=map(int,input().split())\nprint(a+b if a<500 else a+b-1)\n"
SMALL = "import random,sys\nr=random.Random(int(sys.argv[1]))\nprint(r.randint(1,20),r.randint(1,20))\n"
SMALL_INVALID = "import random,sys\nr=random.Random(int(sys.argv[1]))\nprint(r.randint(1,20),0 if int(sys.argv[1])==7 else 5)\n"

YAML = """title: Add
rating: 800
practicePoints: 8
tags: [math]
limits: {timeMs: 500, memMb: 256, outputKb: 1024}
checker: {kind: %s}
samples: ['01']
solutions:
- {file: main.cpp, expected: AC}
%s"""


def make_package(root, main=ADD, brute=ADD, small=SMALL, extra=(), kind="tokens", brute_name="brute.cpp"):
    pkg = os.path.join(root, "adder")
    os.makedirs(os.path.join(pkg, "solutions"))
    os.makedirs(os.path.join(pkg, "stress"))
    decl = ""
    for name, body in extra:
        with open(os.path.join(pkg, "solutions", name), "w") as f:
            f.write(body)
        decl += "- {file: %s, expected: AC}\n" % name
    with open(os.path.join(pkg, "problem.yaml"), "w") as f:
        f.write(YAML % (kind, decl))
    with open(os.path.join(pkg, "validator.cpp"), "w") as f:
        f.write(VALIDATOR)
    with open(os.path.join(pkg, "solutions", "main.cpp"), "w") as f:
        f.write(main)
    if brute is not None:
        with open(os.path.join(pkg, "stress", brute_name), "w") as f:
            f.write(brute)
    with open(os.path.join(pkg, "stress", "small.py"), "w") as f:
        f.write(small)
    return pkg


class StressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.saved = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        for d in self.saved:
            shutil.rmtree(d, ignore_errors=True)

    def run_pkg(self, pkg, n=40):
        r = st.run_stress(pkg, n=n, jobs=4)
        if r.mismatch:
            self.saved.append(r.mismatch[1])
        return r

    def test_FR_PROB_04_correct_package_passes_and_compares_every_program(self):
        pkg = make_package(self.tmp, extra=[("alt.py", ADD_PY)])
        r = self.run_pkg(pkg)
        self.assertIsNone(r.mismatch)
        self.assertEqual(r.cases, 40)
        self.assertEqual(r.programs, 3)  # brute, main.cpp, alt.py
        self.assertEqual(sum(r.sizes.values()), 40)

    def test_FR_PROB_04_planted_off_by_one_in_the_reference_is_caught_with_seed_and_saved_input(self):
        pkg = make_package(self.tmp, main=ADD_OFF_BY_ONE)
        r = self.run_pkg(pkg, n=300)
        self.assertIsNotNone(r.mismatch)
        seed, out_dir, summary = r.mismatch
        self.assertTrue(os.path.isfile(os.path.join(out_dir, f"seed-{seed}.in")))
        self.assertTrue(os.path.isfile(os.path.join(out_dir, f"seed-{seed}.main.cpp.out")))
        self.assertIn("main.cpp", summary)
        self.assertTrue(out_dir.startswith(tempfile.gettempdir()))  # never written into the repository

    def test_FR_PROB_04_a_wrong_alternative_declared_AC_is_caught_too(self):
        pkg = make_package(self.tmp, extra=[("alt.py", ADD_PY_WRONG)])
        # small.py never makes a >= 500, so the wrong branch is unreachable: this documents that only
        # inputs the generator can produce are compared. Use a generator that can reach it.
        with open(os.path.join(pkg, "stress", "small.py"), "w") as f:
            f.write("import random,sys\nr=random.Random(int(sys.argv[1]))\nprint(r.randint(1,1000),r.randint(1,5))\n")
        r = self.run_pkg(pkg, n=100)
        self.assertIsNotNone(r.mismatch)
        self.assertIn("alt.py", r.mismatch[2])

    def test_FR_PROB_04_a_generator_that_breaks_the_constraints_is_an_error_not_a_pass(self):
        pkg = make_package(self.tmp, small=SMALL_INVALID)
        with self.assertRaises(st.StressError) as cm:
            st.run_stress(pkg, n=20, jobs=2)
        self.assertIn("validator rejects", str(cm.exception))
        self.assertIn("seed 7", str(cm.exception))

    def test_FR_PROB_04_missing_brute_force_is_a_clear_error(self):
        pkg = make_package(self.tmp, brute=None)
        with self.assertRaises(st.StressError) as cm:
            st.run_stress(pkg, n=5)
        self.assertIn("brute", str(cm.exception))

    def test_FR_PROB_04_python_brute_force_is_supported(self):
        pkg = make_package(self.tmp, brute=ADD_PY, brute_name="brute.py")
        self.assertIsNone(self.run_pkg(pkg).mismatch)

    def test_FR_PROB_04_unsupported_checker_kind_is_refused(self):
        pkg = make_package(self.tmp, kind="float")
        with self.assertRaises(st.StressError) as cm:
            st.run_stress(pkg, n=5)
        self.assertIn("not supported", str(cm.exception))

    def test_FR_PROB_04_cli_exit_codes(self):
        pkg = make_package(self.tmp)
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(st.main(["-n", "10", pkg]), 0)
        self.assertIn("ok    adder", out.getvalue())
        bad = os.path.join(self.tmp, "bad")
        os.makedirs(bad)
        make_package(bad, main=ADD_OFF_BY_ONE)
        with redirect_stdout(io.StringIO()) as o2:
            self.assertEqual(st.main(["-n", "300", os.path.join(bad, "adder")]), 1)
        self.assertIn("FAIL  adder", o2.getvalue())
        for d in [l.split("saved: ")[1] for l in o2.getvalue().splitlines() if "saved: " in l]:
            self.saved.append(d)

    def test_FR_PROB_04_a_directory_scan_skips_packages_without_stress_and_fails_if_none_ran(self):
        pkg = make_package(self.tmp)
        shutil.rmtree(os.path.join(pkg, "stress"))
        with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
            code = st.main(["-n", "5", self.tmp])
        self.assertEqual(code, 2)
        self.assertIn("skip  adder", out.getvalue())


if __name__ == "__main__":
    unittest.main()
