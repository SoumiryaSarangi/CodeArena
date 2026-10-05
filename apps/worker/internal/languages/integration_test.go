package languages

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

// Needs isolate. JUDGE_REQUIRE_ISOLATE=1 makes a missing isolate a failure;
// JUDGE_REQUIRE_RUNTIMES=1 does the same for a missing language runtime.
func TestIntegration(t *testing.T) {
	skip := func(t *testing.T, env, format string, args ...any) {
		t.Helper()
		if os.Getenv(env) == "1" {
			t.Fatalf(format, args...)
		}
		t.Skipf(format, args...)
	}
	for _, bin := range []string{"isolate", "taskset"} {
		if _, err := exec.LookPath(bin); err != nil {
			skip(t, "JUDGE_REQUIRE_ISOLATE", "%s not installed", bin)
		}
	}
	ctx := context.Background()
	// Box ids 930+ keep clear of the sandbox package tests (900+).
	pool, err := sandbox.New(ctx, sandbox.Config{Cores: []int{2}, BoxIDBase: 930})
	if err != nil {
		skip(t, "JUDGE_REQUIRE_ISOLATE", "isolate unusable: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close(ctx) })
	reg, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	lim := contracts.Limits{TimeMS: 2000, MemMB: 256, OutputKB: 65536}

	// judge compiles in the compile box, installs into the run box and runs.
	judge := func(t *testing.T, l *Language, src, stdin string) (*CompileResult, string, sandbox.Meta) {
		t.Helper()
		slot, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pool.Release(ctx, slot) })
		res, err := reg.Compile(ctx, slot.Compile, l, src)
		if err != nil {
			t.Fatal(err)
		}
		if !res.OK {
			return res, "", sandbox.Meta{}
		}
		if err := Install(ctx, slot.Run, res.Artifacts); err != nil {
			t.Fatal(err)
		}
		if stdin != "" {
			if err := slot.Run.WriteFile("in.txt", []byte(stdin), 0o644); err != nil {
				t.Fatal(err)
			}
			stdin = "in.txt"
		}
		meta, err := slot.Run.Run(ctx, l.RunSpec(lim, stdin, "out.txt", "err.txt"))
		if err != nil {
			t.Fatal(err)
		}
		out, _, _ := slot.Run.ReadFile("out.txt", 1<<20)
		return res, string(out), meta
	}
	source := func(t *testing.T, name string) string {
		t.Helper()
		b, err := os.ReadFile("testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	runtimeFor := map[contracts.Language]string{"c": "/usr/bin/gcc", "cpp17": "/usr/bin/g++", "cpp20": "/usr/bin/g++", "python3": "/usr/bin/python3", "java21": "/usr/lib/jvm/java-21-openjdk-amd64/bin/javac", "node": "/usr/bin/node"}
	srcFor := map[contracts.Language]string{"c": "c.c", "cpp17": "cpp.cpp", "cpp20": "cpp.cpp", "python3": "python3.py", "java21": "java21.java", "node": "node.js"}

	for _, id := range reg.IDs() {
		l, _ := reg.Get(id)
		t.Run("FR-JUDGE-01: hello world is AC in "+string(id), func(t *testing.T) {
			if _, err := os.Stat(runtimeFor[id]); err != nil {
				skip(t, "JUDGE_REQUIRE_RUNTIMES", "%s is not installed", runtimeFor[id])
			}
			res, out, meta := judge(t, l, source(t, srcFor[id]), "")
			if !res.OK {
				t.Fatalf("compile failed: %s (%+v)", res.Log, res.Meta)
			}
			if meta.Status != sandbox.StatusOK || out != "hello\n" {
				t.Fatalf("out %q meta %+v", out, meta)
			}
		})
	}

	t.Run("FR-JUDGE-02: a compile error returns the compiler log, not an error", func(t *testing.T) {
		l, _ := reg.Get("c")
		res, _, _ := judge(t, l, "int main( { return 0; }\n", "")
		if res.OK || !strings.Contains(res.Log, "main.c") || len(res.Artifacts) != 0 {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("FR-JUDGE-02: Python syntax errors are compile errors", func(t *testing.T) {
		l, _ := reg.Get("python3")
		res, _, _ := judge(t, l, "def f(:\n  pass\n", "")
		if res.OK || !strings.Contains(res.Log, "SyntaxError") {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("FR-JUDGE-02: the compiler cannot see host files outside the box", func(t *testing.T) {
		l, _ := reg.Get("c")
		// #include of a host file the sandbox cannot see is a compile error.
		res, _, _ := judge(t, l, "#include \"/etc/passwd\"\nint main(void){return 0;}\n", "")
		if res.OK {
			t.Fatal("compiled a program that includes a host file")
		}
	})
	t.Run("FR-JUDGE-02: a compiler that spins is killed at the compile CPU limit and reported as CE", func(t *testing.T) {
		spin, err := Parse([]byte(`
compile: {cpuSeconds: 1, memMb: 512, fsizeKb: 1024, processes: 8, logKb: 16}
languages:
  - {id: c, name: spin, sourceFile: main.c, compile: [/usr/bin/python3, -c, "while True: pass"], run: [./main], artifacts: [main], processes: 1, memOverheadMb: 0, timeMultiplier: 1}
`))
		if err != nil {
			t.Fatal(err)
		}
		l, _ := spin.Get("c")
		slot, _ := pool.Acquire(ctx)
		defer func() { _ = pool.Release(ctx, slot) }()
		res, err := spin.Compile(ctx, slot.Compile, l, "int main(void){return 0;}\n")
		if err != nil || res.OK || res.Meta.Status != sandbox.StatusTO || !strings.Contains(res.Log, "timed out") {
			t.Fatalf("%+v %v", res, err)
		}
	})
	t.Run("FR-JUDGE-02: oversize source is refused", func(t *testing.T) {
		l, _ := reg.Get("c")
		slot, _ := pool.Acquire(ctx)
		defer func() { _ = pool.Release(ctx, slot) }()
		if _, err := reg.Compile(ctx, slot.Compile, l, strings.Repeat("a", MaxSourceBytes+1)); err != ErrSourceTooLarge {
			t.Fatalf("got %v", err)
		}
	})
}
