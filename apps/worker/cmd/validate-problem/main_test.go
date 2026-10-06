package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/languages"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

const fixtures = "../../../../problems"

func TestExpand(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"b-pkg", "a-pkg", "_template", ".hidden", "not-a-package"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range []string{"b-pkg", "a-pkg", "_template", ".hidden"} {
		if err := os.WriteFile(filepath.Join(root, d, "problem.yaml"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("FR-PROB-04: a directory of packages expands to its packages, sorted, skipping _ and . directories", func(t *testing.T) {
		got, err := expand([]string{root})
		if err != nil || len(got) != 2 || filepath.Base(got[0]) != "a-pkg" || filepath.Base(got[1]) != "b-pkg" {
			t.Fatalf("%v %v", got, err)
		}
	})
	t.Run("a package directory stands for itself", func(t *testing.T) {
		got, err := expand([]string{filepath.Join(root, "b-pkg")})
		if err != nil || len(got) != 1 {
			t.Fatalf("%v %v", got, err)
		}
	})
	t.Run("nothing found is an error", func(t *testing.T) {
		if _, err := expand([]string{t.TempDir()}); err == nil {
			t.Fatal("expected an error")
		}
		if _, err := expand([]string{"/definitely/not/here"}); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestWriteTar(t *testing.T) {
	out := filepath.Join(t.TempDir(), "t.tar")
	if code := writeTar([]string{filepath.Join(fixtures, "sum-two-numbers")}, out); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if fi, err := os.Stat(out); err != nil || fi.Size() == 0 {
		t.Fatalf("%v %v", fi, err)
	}
	if writeTar([]string{"a", "b"}, out) == 0 {
		t.Fatal("two packages should be refused")
	}
}

// copyPkg copies a fixture package so a test can break it.
func copyPkg(t *testing.T, name string) string {
	t.Helper()
	dst := filepath.Join(t.TempDir(), name)
	cmd := exec.Command("cp", "-r", filepath.Join(fixtures, name), dst)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return dst
}

// TestValidate runs the real thing on a small fixture. Needs isolate and gcc;
// JUDGE_REQUIRE_ISOLATE=1 turns a skip into a failure.
func TestValidate(t *testing.T) {
	for _, bin := range []string{"isolate", "taskset", "g++"} {
		if _, err := exec.LookPath(bin); err != nil {
			if os.Getenv("JUDGE_REQUIRE_ISOLATE") == "1" {
				t.Fatalf("%s not installed", bin)
			}
			t.Skipf("%s not installed", bin)
		}
	}
	ctx := context.Background()
	reg, err := languages.Default()
	if err != nil {
		t.Fatal(err)
	}
	// Box ids 850+ keep clear of the command itself (800+) and the package tests.
	pool, err := sandbox.New(ctx, sandbox.Config{Cores: []int{1, 2}, BoxIDBase: 850})
	if err != nil {
		t.Skipf("isolate unusable: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close(ctx) })
	v := &validator{pool: pool, reg: reg, eng: &judge.Engine{Reg: reg}}

	t.Run("FR-PROB-04: a good package passes", func(t *testing.T) {
		if !v.validate(ctx, filepath.Join(fixtures, "sum-two-numbers")) {
			t.Fatal("a valid fixture failed")
		}
	})
	t.Run("FR-PROB-04: a solution whose actual verdict differs from the declared one fails the package", func(t *testing.T) {
		dir := copyPkg(t, "sum-two-numbers")
		y := filepath.Join(dir, "problem.yaml")
		b, _ := os.ReadFile(y)
		// declare the int32 solution as AC: it is really WA
		fixed := strings.Replace(string(b), "{file: wa-int32.cpp, expected: WA}", "{file: wa-int32.cpp, expected: AC}", 1)
		if fixed == string(b) {
			t.Fatal("fixture layout changed")
		}
		if err := os.WriteFile(y, []byte(fixed), 0o644); err != nil {
			t.Fatal(err)
		}
		if v.validate(ctx, dir) {
			t.Fatal("a mislabelled solution was accepted")
		}
	})
	t.Run("FR-PROB-04: the validator rejecting a test input fails the package", func(t *testing.T) {
		dir := copyPkg(t, "sum-two-numbers")
		// a value outside the declared range: 10^19
		if err := os.WriteFile(filepath.Join(dir, "tests", "03.in"), []byte("10000000000000000000 1\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if v.validate(ctx, dir) {
			t.Fatal("an input outside the validator's range was accepted")
		}
	})
	t.Run("FR-PROB-04: a wrong expected answer makes the reference fail", func(t *testing.T) {
		dir := copyPkg(t, "sum-two-numbers")
		if err := os.WriteFile(filepath.Join(dir, "tests", "01.ans"), []byte("999\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if v.validate(ctx, dir) {
			t.Fatal("a wrong .ans was accepted")
		}
	})
	t.Run("a structurally broken package fails without running anything", func(t *testing.T) {
		dir := copyPkg(t, "sum-two-numbers")
		if err := os.Remove(filepath.Join(dir, "statement.md")); err != nil {
			t.Fatal(err)
		}
		if v.validate(ctx, dir) {
			t.Fatal("a package without a statement was accepted")
		}
	})
}
