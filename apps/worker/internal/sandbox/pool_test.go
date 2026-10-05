package sandbox

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeExec answers isolate calls without running anything.
type fakeExec struct {
	mu    sync.Mutex
	calls [][]string
	// runCode and runMeta answer --run; initCode answers --init.
	runCode  int
	runMeta  string
	initCode int
	cleanErr bool
}

func (f *fakeExec) Exec(_ context.Context, argv []string) (ExecResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, argv)
	args := argv[4:]
	id := strings.TrimPrefix(args[0], "--box-id=")
	switch args[2] {
	case "--init":
		if f.initCode != 0 {
			return ExecResult{Code: f.initCode, Stderr: []byte("Box already in use")}, nil
		}
		return ExecResult{Stdout: []byte("/var/local/lib/isolate/" + id + "\n")}, nil
	case "--cleanup":
		if f.cleanErr {
			return ExecResult{Code: 2, Stderr: []byte("cannot clean")}, nil
		}
		return ExecResult{}, nil
	case "--run":
		for _, a := range args {
			if p, ok := strings.CutPrefix(a, "--meta="); ok {
				if err := os.WriteFile(p, []byte(f.runMeta), 0o600); err != nil {
					return ExecResult{}, err
				}
			}
		}
		return ExecResult{Code: f.runCode, Stderr: []byte("isolate says no")}, nil
	}
	return ExecResult{}, errors.New("unexpected call")
}

func (f *fakeExec) ops() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		out = append(out, strings.TrimPrefix(c[4], "--box-id=")+c[6])
	}
	return out
}

func (f *fakeExec) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

func newTestPool(t *testing.T, f *fakeExec, cores ...int) *Pool {
	t.Helper()
	p, err := New(context.Background(), Config{Cores: cores, BoxIDBase: 100, Exec: f, MetaDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPoolLayout(t *testing.T) {
	t.Run("FR-JUDGE-13: one slot per core, three boxes pinned to it", func(t *testing.T) {
		f := &fakeExec{}
		p := newTestPool(t, f, 2, 5)
		if p.Size() != 2 {
			t.Fatalf("size %d", p.Size())
		}
		ctx := context.Background()
		a, _ := p.Acquire(ctx)
		b, _ := p.Acquire(ctx)
		for i, s := range []*Slot{a, b} {
			wantCore := []int{2, 5}[i]
			base := 100 + 3*i
			if s.Core != wantCore {
				t.Fatalf("slot %d core %d", i, s.Core)
			}
			for j, box := range s.boxes() {
				if box.ID != base+j || box.Core != wantCore {
					t.Fatalf("slot %d box %d: id %d core %d", i, j, box.ID, box.Core)
				}
			}
		}
	})

	t.Run("FR-JUDGE-13: every isolate call is wrapped in taskset -c <core>", func(t *testing.T) {
		f := &fakeExec{}
		p := newTestPool(t, f, 5)
		f.reset()
		s, _ := p.Acquire(context.Background())
		must(t, s.Run.Init(context.Background()))
		want := []string{"taskset", "-c", "5", "isolate", "--box-id=101", "--cg", "--init"}
		if !reflect.DeepEqual(f.calls[0], want) {
			t.Fatalf("argv %q", f.calls[0])
		}
	})

	t.Run("rejects duplicate or negative cores", func(t *testing.T) {
		for _, cores := range [][]int{{1, 1}, {-1}} {
			if _, err := New(context.Background(), Config{Cores: cores, Exec: &fakeExec{}, MetaDir: t.TempDir()}); err == nil {
				t.Fatalf("accepted %v", cores)
			}
		}
	})
}

func TestPoolLifecycle(t *testing.T) {
	t.Run("startup cleans every box a crashed worker may have left", func(t *testing.T) {
		f := &fakeExec{}
		newTestPool(t, f, 0, 1)
		want := []string{"100--cleanup", "101--cleanup", "102--cleanup", "103--cleanup", "104--cleanup", "105--cleanup"}
		if got := f.ops(); !reflect.DeepEqual(got, want) {
			t.Fatalf("ops %q", got)
		}
	})

	t.Run("release cleans all three boxes and returns the slot", func(t *testing.T) {
		f := &fakeExec{}
		p := newTestPool(t, f, 0)
		ctx := context.Background()
		s, _ := p.Acquire(ctx)
		must(t, s.Run.Init(ctx))
		f.reset()
		must(t, p.Release(ctx, s))
		if got := f.ops(); !reflect.DeepEqual(got, []string{"100--cleanup", "101--cleanup", "102--cleanup"}) {
			t.Fatalf("ops %q", got)
		}
		if s.Run.Dir() != "" {
			t.Fatal("dir survived cleanup")
		}
		if again, err := p.Acquire(ctx); err != nil || again != s {
			t.Fatalf("slot not returned: %v", err)
		}
	})

	t.Run("release returns the slot even when cleanup fails", func(t *testing.T) {
		f := &fakeExec{}
		p := newTestPool(t, f, 0)
		ctx := context.Background()
		s, _ := p.Acquire(ctx)
		f.cleanErr = true
		if err := p.Release(ctx, s); !errors.Is(err, ErrSandbox) {
			t.Fatalf("want ErrSandbox, got %v", err)
		}
		f.cleanErr = false
		if _, err := p.Acquire(ctx); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("acquire waits and honours ctx cancel", func(t *testing.T) {
		p := newTestPool(t, &fakeExec{}, 0)
		_, _ = p.Acquire(context.Background())
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		if _, err := p.Acquire(ctx); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("new fails when a startup cleanup fails", func(t *testing.T) {
		if _, err := New(context.Background(), Config{Cores: []int{0}, Exec: &fakeExec{cleanErr: true}, MetaDir: t.TempDir()}); !errors.Is(err, ErrSandbox) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestBoxRun(t *testing.T) {
	spec := validSpec()
	setup := func(t *testing.T, f *fakeExec) *Box {
		p := newTestPool(t, f, 0)
		s, _ := p.Acquire(context.Background())
		must(t, s.Run.Init(context.Background()))
		if s.Run.Dir() != "/var/local/lib/isolate/101/box" {
			t.Fatalf("dir %q", s.Run.Dir())
		}
		return s.Run
	}

	t.Run("program failure (exit 1) returns meta, no error", func(t *testing.T) {
		b := setup(t, &fakeExec{runCode: 1, runMeta: "status:RE\nexitcode:3\n"})
		m, err := b.Run(context.Background(), spec)
		if err != nil || m.Status != StatusRE || m.ExitCode != 3 {
			t.Fatalf("%+v %v", m, err)
		}
	})

	t.Run("isolate exit 2 is ErrSandbox with its stderr", func(t *testing.T) {
		b := setup(t, &fakeExec{runCode: 2})
		_, err := b.Run(context.Background(), spec)
		if !errors.Is(err, ErrSandbox) || !strings.Contains(err.Error(), "isolate says no") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("status XX is ErrSandbox", func(t *testing.T) {
		b := setup(t, &fakeExec{runCode: 1, runMeta: "status:XX\nmessage:boom\n"})
		if _, err := b.Run(context.Background(), spec); !errors.Is(err, ErrSandbox) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("malformed meta is ErrSandbox", func(t *testing.T) {
		b := setup(t, &fakeExec{runMeta: "garbage\n"})
		if _, err := b.Run(context.Background(), spec); !errors.Is(err, ErrSandbox) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("init failure is ErrSandbox", func(t *testing.T) {
		p := newTestPool(t, &fakeExec{initCode: 2}, 0)
		s, _ := p.Acquire(context.Background())
		if err := s.Run.Init(context.Background()); !errors.Is(err, ErrSandbox) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("file operations and run need Init", func(t *testing.T) {
		p := newTestPool(t, &fakeExec{}, 0)
		s, _ := p.Acquire(context.Background())
		if _, err := s.Run.Run(context.Background(), spec); !errors.Is(err, ErrNotInitialized) {
			t.Fatal(err)
		}
		if err := s.Run.WriteFile("a", nil, 0o644); !errors.Is(err, ErrNotInitialized) {
			t.Fatal(err)
		}
		if _, _, err := s.Run.ReadFile("a", 1); !errors.Is(err, ErrNotInitialized) {
			t.Fatal(err)
		}
	})

	t.Run("invalid spec never reaches isolate", func(t *testing.T) {
		f := &fakeExec{}
		b := setup(t, f)
		f.reset()
		bad := spec
		bad.Dirs = []string{"/"}
		if _, err := b.Run(context.Background(), bad); !errors.Is(err, ErrInvalidSpec) {
			t.Fatal(err)
		}
		if len(f.ops()) != 0 {
			t.Fatal("isolate was called")
		}
	})
}
