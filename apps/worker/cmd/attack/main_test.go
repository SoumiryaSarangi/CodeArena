package main

import (
	"os"
	"os/exec"
	"testing"
)

const selftest = "../../../../tests/attack-suite/selftest"

// TestSelftest runs the two self-test cases through the real runner: the clean
// one must pass, the forbidden-marker one must be reported as failing. Needs
// isolate and gcc; JUDGE_REQUIRE_ISOLATE=1 turns a skip into a failure.
func TestSelftest(t *testing.T) {
	for _, bin := range []string{"isolate", "taskset", "gcc"} {
		if _, err := exec.LookPath(bin); err != nil {
			if os.Getenv("JUDGE_REQUIRE_ISOLATE") == "1" {
				t.Fatalf("%s not installed", bin)
			}
			t.Skipf("%s not installed", bin)
		}
	}

	t.Run("FR-JUDGE-10: the clean self-test case passes (min floor relaxed to 1)", func(t *testing.T) {
		if code := run(selftest+"/01-hello-ok", 1, false, 1); code != 0 {
			t.Fatalf("clean case did not pass, exit %d", code)
		}
	})
	t.Run("FR-JUDGE-10: a case whose program leaks a forbidden marker is reported as failing", func(t *testing.T) {
		if code := run(selftest+"/02-marker-fail", 1, true, 1); code != 1 {
			t.Fatalf("forbidden-marker case should fail, exit %d", code)
		}
	})
	t.Run("too few cases fails even when every case passes", func(t *testing.T) {
		// One passing case, but the FR-JUDGE-10 floor is 25.
		if code := run(selftest+"/01-hello-ok", 1, false, 25); code != 1 {
			t.Fatalf("should fail the min-cases floor, exit %d", code)
		}
	})
	t.Run("a missing target is a usage error", func(t *testing.T) {
		if code := run("/definitely/not/here", 1, false, 1); code != 2 {
			t.Fatalf("exit %d", code)
		}
	})
}
