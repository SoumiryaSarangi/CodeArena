package sandbox

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestIntegration runs a real C program in real isolate boxes. It skips when
// isolate, taskset or gcc are missing (the CI go job has no isolate yet; J-07
// adds it). JUDGE_REQUIRE_ISOLATE=1 turns the skip into a failure.
func TestIntegration(t *testing.T) {
	skip := func(format string, args ...any) {
		t.Helper()
		if os.Getenv("JUDGE_REQUIRE_ISOLATE") == "1" {
			t.Fatalf(format, args...)
		}
		t.Skipf(format, args...)
	}
	for _, bin := range []string{"isolate", "taskset", "gcc"} {
		if _, err := exec.LookPath(bin); err != nil {
			skip("%s not installed", bin)
		}
	}

	probe := filepath.Join(t.TempDir(), "probe")
	if out, err := exec.Command("gcc", "-O2", "-static", "-pthread", "-o", probe, "testdata/probe.c").CombinedOutput(); err != nil {
		skip("cannot build static probe: %v\n%s", err, out)
	}
	bin, err := os.ReadFile(probe)
	must(t, err)

	core := 0
	if runtime.NumCPU() > 1 {
		core = 1
	}
	ctx := context.Background()
	// Box ids 900+ keep clear of a dev worker running on the same machine.
	pool, err := New(ctx, Config{Cores: []int{core}, BoxIDBase: 900})
	if err != nil {
		skip("isolate unusable: %v", err)
	}
	t.Cleanup(func() { must(t, pool.Close(ctx)) })

	type result struct {
		meta Meta
		box  *Box
	}
	// run puts the probe (and optional stdin) into a fresh run box and runs it.
	run := func(t *testing.T, spec RunSpec, mode, stdin string) result {
		t.Helper()
		slot, err := pool.Acquire(ctx)
		must(t, err)
		t.Cleanup(func() { must(t, pool.Release(ctx, slot)) })
		b := slot.Run
		if err := b.Init(ctx); err != nil {
			skip("box init failed: %v", err)
		}
		must(t, b.WriteFile("probe", bin, 0o755))
		if stdin != "" {
			must(t, b.WriteFile("in.txt", []byte(stdin), 0o644))
			spec.Stdin = "in.txt"
		}
		spec.Cmd = []string{"./probe", mode}
		m, err := b.Run(ctx, spec)
		must(t, err)
		return result{m, b}
	}
	base := func() RunSpec {
		return RunSpec{TimeLimit: 2 * time.Second, MemKB: 262144, Processes: 1, FsizeKB: 65536, Stdout: "out.txt", Stderr: "err.txt"}
	}
	output := func(t *testing.T, r result) string {
		t.Helper()
		data, trunc, err := r.box.ReadFile("out.txt", 1<<20)
		must(t, err)
		if trunc {
			t.Fatal("output truncated")
		}
		return string(data)
	}

	t.Run("J-01 accept: a C program runs in a box and its output is read back", func(t *testing.T) {
		r := run(t, base(), "sum", "2 40\n")
		if r.meta.Status != StatusOK || r.meta.ExitCode != 0 {
			t.Fatalf("meta %+v", r.meta)
		}
		if got := output(t, r); got != "42\n" {
			t.Fatalf("output %q", got)
		}
		if r.meta.CgMemKB <= 0 || r.meta.WallMS < 0 {
			t.Fatalf("missing usage in %+v", r.meta)
		}
	})

	t.Run("FR-JUDGE-03: environment is PATH only (plus isolate's LIBC_FATAL_STDERR_)", func(t *testing.T) {
		r := run(t, base(), "env", "")
		got := strings.Fields(output(t, r))
		slices.Sort(got)
		want := []string{"LIBC_FATAL_STDERR_=1", "PATH=/usr/bin:/bin"}
		if !slices.Equal(got, want) {
			t.Fatalf("env %q", got)
		}
	})

	t.Run("FR-JUDGE-03: no network", func(t *testing.T) {
		r := run(t, base(), "net", "")
		if got := output(t, r); got != "udp:fail tcp:fail\n" {
			t.Fatalf("network reachable: %q", got)
		}
	})

	t.Run("FR-JUDGE-03: CPU time limit gives TO", func(t *testing.T) {
		s := base()
		s.TimeLimit = 500 * time.Millisecond
		r := run(t, s, "spin", "")
		if r.meta.Status != StatusTO || r.meta.TimeMS < 500 {
			t.Fatalf("meta %+v", r.meta)
		}
	})

	t.Run("FR-JUDGE-03: wall time (3T+1s) stops a sleeping program", func(t *testing.T) {
		s := base()
		s.TimeLimit = 300 * time.Millisecond
		r := run(t, s, "sleep", "")
		if r.meta.Status != StatusTO || !strings.Contains(r.meta.Message, "wall") {
			t.Fatalf("meta %+v", r.meta)
		}
		if r.meta.WallMS < 1900 || r.meta.WallMS > 4000 {
			t.Fatalf("wall %d ms, want about 1900", r.meta.WallMS)
		}
	})

	t.Run("FR-JUDGE-03: memory limit kills via the cgroup OOM killer", func(t *testing.T) {
		s := base()
		s.MemKB = 65536
		r := run(t, s, "oom", "")
		if !r.meta.OOMKilled {
			t.Fatalf("meta %+v", r.meta)
		}
	})

	t.Run("FR-JUDGE-03: file size limit kills with SIGXFSZ", func(t *testing.T) {
		s := base()
		s.FsizeKB = 1024
		r := run(t, s, "fsize", "")
		if r.meta.Status != StatusSG || r.meta.Signal() != "SIGXFSZ" {
			t.Fatalf("meta %+v", r.meta)
		}
	})

	t.Run("FR-JUDGE-03: process limit blocks fork", func(t *testing.T) {
		r := run(t, base(), "fork", "")
		if got := output(t, r); got != "fork-failed\n" {
			t.Fatalf("output %q", got)
		}
	})

	t.Run("FR-JUDGE-04: CPU time counts every thread", func(t *testing.T) {
		s := base()
		s.TimeLimit, s.Processes = 5*time.Second, 8
		r := run(t, s, "threads", "")
		// 4 threads x 0.3 s of thread CPU time each.
		if r.meta.Status != StatusOK || r.meta.TimeMS < 1150 {
			t.Fatalf("meta %+v", r.meta)
		}
	})

	t.Run("FR-JUDGE-04: CPU time counts child processes", func(t *testing.T) {
		s := base()
		s.TimeLimit, s.Processes = 5*time.Second, 2
		r := run(t, s, "child", "")
		// Parent and child burn 0.3 s each.
		if r.meta.Status != StatusOK || r.meta.TimeMS < 570 {
			t.Fatalf("meta %+v", r.meta)
		}
	})

	t.Run("FR-JUDGE-13: the box runs pinned to its slot's core", func(t *testing.T) {
		r := run(t, base(), "affinity", "")
		if got := output(t, r); got != strconv.Itoa(core)+"\n" {
			t.Fatalf("affinity %q, want %d", got, core)
		}
	})

	t.Run("J-08: a box sees only the prepared /dev, and the devices programs need still work", func(t *testing.T) {
		r := run(t, base(), "dev", "piped\n")
		out := output(t, r)
		var entries []string
		for _, line := range strings.Split(out, "\n") {
			if name, ok := strings.CutPrefix(line, "entry "); ok {
				entries = append(entries, name)
			}
		}
		slices.Sort(entries)
		want := []string{"fd", "full", "null", "random", "shm", "stderr", "stdin", "stdout", "urandom", "zero"}
		if !slices.Equal(entries, want) {
			t.Fatalf("/dev inside the box is %q, want %q", entries, want)
		}
		for _, w := range []string{"null ok", "urandom ok", "stdin ok", "shm ok"} {
			if !strings.Contains(out, w) {
				t.Fatalf("missing %q in\n%s", w, out)
			}
		}
	})

	// isolate 2.7 deletes non-regular files from the box after each run, so a
	// planted symlink or FIFO is normally gone; ReadFile is the second layer
	// (exercised directly in safefs_test.go). Either way nothing is followed.
	notFollowed := func(t *testing.T, mode string) {
		t.Helper()
		s := base()
		s.Stdout = ""
		r := run(t, s, mode, "")
		if r.meta.Status != StatusOK {
			t.Fatalf("meta %+v", r.meta)
		}
		done := make(chan error, 1)
		go func() {
			data, _, err := r.box.ReadFile("out.txt", 1<<20)
			if err == nil {
				err = errors.New("read " + strconv.Itoa(len(data)) + " bytes through a planted " + mode)
			}
			done <- err
		}()
		select {
		case err := <-done:
			if !errors.Is(err, ErrUnsafeFile) && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("want ErrUnsafeFile or ErrNotExist, got %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("ReadFile hung")
		}
	}

	t.Run("FR-JUDGE-08: a symlink planted by the program is not followed", func(t *testing.T) {
		notFollowed(t, "symlink")
	})

	t.Run("FR-JUDGE-08: a FIFO planted by the program does not hang the host", func(t *testing.T) {
		notFollowed(t, "fifo")
	})
}
