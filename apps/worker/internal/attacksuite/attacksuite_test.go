package attacksuite

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

const validYAML = `title: probe
language: c
mode: run
input: "hi\n"
expect:
  verdicts: [AC, RE]
  outputLacks: [ESCAPED]
  outputHas: [BLOCKED]
  host: [no-leftover-procs, worker-alive, env-clean]
limits: {timeMs: 500, memMb: 128, outputKb: 32}
`

func writeCase(t *testing.T, name, yaml, srcName, src string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if yaml != "" {
		if err := os.WriteFile(filepath.Join(dir, "case.yaml"), []byte(yaml), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if srcName != "" {
		if err := os.WriteFile(filepath.Join(dir, srcName), []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestLoadValid(t *testing.T) {
	c, err := Load(writeCase(t, "01-probe", validYAML, "main.c", "int main(){}"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Slug != "01-probe" || c.Language != contracts.LanguageC || c.Mode != ModeRun || c.Input != "hi\n" {
		t.Fatalf("%+v", c)
	}
	if c.Limits.TimeMS != 500 || c.Limits.MemMB != 128 || c.Limits.OutputKB != 32 {
		t.Fatalf("%+v", c.Limits)
	}
	if !strings.HasSuffix(c.SourceFile, "main.c") {
		t.Fatalf("source %q", c.SourceFile)
	}
}

func TestDefaults(t *testing.T) {
	y := "title: t\nlanguage: python3\nexpect:\n  verdicts: [AC]\n"
	c, err := Load(writeCase(t, "02-defaults", y, "main.py", "print(1)"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Mode != ModeRun || c.Limits != DefaultLimits {
		t.Fatalf("%+v", c)
	}
}

func TestLanguageFromExtension(t *testing.T) {
	y := "title: t\nmode: run\nexpect:\n  verdicts: [AC]\n"
	c, err := Load(writeCase(t, "03-infer", y, "main.js", "console.log(1)"))
	if err != nil || c.Language != contracts.LanguageNode {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestLoadRejects(t *testing.T) {
	cases := map[string]struct {
		yaml, srcName, src, want string
	}{
		"bad slug":           {validYAML, "main.c", "x", ""}, // handled separately below
		"missing title":      {"language: c\nexpect:\n  verdicts: [AC]\n", "main.c", "x", "title is required"},
		"no verdicts":        {"title: t\nlanguage: c\nexpect: {}\n", "main.c", "x", "at least one allowed verdict"},
		"unknown verdict":    {"title: t\nlanguage: c\nexpect:\n  verdicts: [AC, WONTFIX]\n", "main.c", "x", "unknown verdict"},
		"unknown host":       {"title: t\nlanguage: c\nexpect:\n  verdicts: [AC]\n  host: [rm-rf]\n", "main.c", "x", "unknown check"},
		"unknown language":   {"title: t\nlanguage: rust\nexpect:\n  verdicts: [AC]\n", "main.rs", "x", "unknown language"},
		"bad mode":           {"title: t\nlanguage: c\nmode: hack\nexpect:\n  verdicts: [AC]\n", "main.c", "x", "not run or submit"},
		"unknown field":      {"title: t\nlanguage: c\nbogus: 1\nexpect:\n  verdicts: [AC]\n", "main.c", "x", "bogus"},
		"missing program":    {"title: t\nlanguage: c\nexpect:\n  verdicts: [AC]\n", "", "", "no main.c"},
		"no language no ext": {"title: t\nexpect:\n  verdicts: [AC]\n", "notmain.txt", "x", "no main"},
		"zero limits":        {"title: t\nlanguage: c\nexpect:\n  verdicts: [AC]\nlimits: {timeMs: 0, memMb: 1, outputKb: 1}\n", "main.c", "x", "limits must be positive"},
	}
	for name, c := range cases {
		if name == "bad slug" {
			continue
		}
		t.Run("rejects "+name, func(t *testing.T) {
			_, err := Load(writeCase(t, "10-case", c.yaml, c.srcName, c.src))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want error containing %q, got %v", c.want, err)
			}
		})
	}
	t.Run("rejects a non-slug directory name", func(t *testing.T) {
		if _, err := Load(writeCase(t, "Bad_Name", validYAML, "main.c", "x")); err == nil || !strings.Contains(err.Error(), "slug") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("rejects two programs without a declared language", func(t *testing.T) {
		dir := writeCase(t, "11-two", "title: t\nexpect:\n  verdicts: [AC]\n", "main.c", "x")
		if err := os.WriteFile(filepath.Join(dir, "main.py"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "several main") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("itemises several errors at once", func(t *testing.T) {
		_, err := Load(writeCase(t, "12-many", "language: c\nexpect:\n  verdicts: [NOPE]\n  host: [bad]\n", "main.c", "x"))
		for _, w := range []string{"title is required", "unknown verdict", "unknown check"} {
			if err == nil || !strings.Contains(err.Error(), w) {
				t.Fatalf("missing %q in %v", w, err)
			}
		}
	})
}

func mustLoad(t *testing.T) *Case {
	t.Helper()
	c, err := Load(writeCase(t, "20-match", validYAML, "main.c", "int main(){}"))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestMatch(t *testing.T) {
	c := mustLoad(t) // verdicts AC/RE, lacks ESCAPED, has BLOCKED
	t.Run("passes when verdict allowed, forbidden absent, required present, host clean", func(t *testing.T) {
		if f := c.Match(Outcome{Verdict: contracts.VerdictRE, Output: "tried BLOCKED fork"}); len(f) != 0 {
			t.Fatalf("%v", f)
		}
	})
	t.Run("fails on a disallowed verdict", func(t *testing.T) {
		f := c.Match(Outcome{Verdict: contracts.VerdictAC + "X", Output: "BLOCKED"})
		if len(f) == 0 || !strings.Contains(f[0], "not one of") {
			t.Fatalf("%v", f)
		}
	})
	t.Run("fails when a forbidden string leaks through", func(t *testing.T) {
		f := c.Match(Outcome{Verdict: contracts.VerdictAC, Output: "BLOCKED but also ESCAPED network"})
		if !contains(f, "must not contain") {
			t.Fatalf("%v", f)
		}
	})
	t.Run("fails when a required string is missing", func(t *testing.T) {
		f := c.Match(Outcome{Verdict: contracts.VerdictAC, Output: "nothing"})
		if !contains(f, "must contain") {
			t.Fatalf("%v", f)
		}
	})
	t.Run("surfaces host-check failures", func(t *testing.T) {
		f := c.Match(Outcome{Verdict: contracts.VerdictAC, Output: "BLOCKED", HostFailures: []string{"no-leftover-procs"}})
		if !contains(f, "host check failed: no-leftover-procs") {
			t.Fatalf("%v", f)
		}
	})
	t.Run("a run error is the only failure reported", func(t *testing.T) {
		f := c.Match(Outcome{RunError: "isolate exploded"})
		if len(f) != 1 || !strings.Contains(f[0], "isolate exploded") {
			t.Fatalf("%v", f)
		}
	})
}

func TestLoadAll(t *testing.T) {
	root := t.TempDir()
	cases := filepath.Join(root, "cases")
	for _, n := range []string{"01-a", "02-b"} {
		d := filepath.Join(cases, n)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "case.yaml"), []byte(validYAML), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "main.c"), []byte("int main(){}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// a directory with no case.yaml is skipped, not an error
	if err := os.MkdirAll(filepath.Join(cases, "_scratch"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := LoadAll(root)
	if err != nil || len(got) != 2 {
		t.Fatalf("%d cases, %v", len(got), err)
	}
}

func contains(xs []string, sub string) bool {
	for _, x := range xs {
		if strings.Contains(x, sub) {
			return true
		}
	}
	return false
}
