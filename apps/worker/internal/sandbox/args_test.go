package sandbox

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func validSpec() RunSpec {
	return RunSpec{
		TimeLimit: 2 * time.Second,
		MemKB:     262144,
		Processes: 1,
		FsizeKB:   65536,
		Stdin:     "in.txt",
		Stdout:    "out.txt",
		Stderr:    "err.txt",
		Dirs:      []string{"/usr/lib/jvm"},
		Cmd:       []string{"./main", "arg"},
	}
}

func TestRunArgsGolden(t *testing.T) {
	t.Run("FR-JUDGE-03: run argv carries every limit, PATH-only env, cgroup mode", func(t *testing.T) {
		got, err := RunArgs(7, "/run/meta/7.meta", validSpec())
		if err != nil {
			t.Fatal(err)
		}
		want := []string{
			"--box-id=7", "--cg", "--run", "--meta=/run/meta/7.meta",
			"--time=2.000", "--extra-time=0.500", "--wall-time=7.000",
			"--cg-mem=262144", "--processes=1", "--fsize=65536", "--stack=262144",
			"--open-files=64", "--env=PATH=/usr/bin:/bin",
			"--stdin=in.txt", "--stdout=out.txt", "--stderr=err.txt",
			"--dir=/usr/lib/jvm", "--", "./main", "arg",
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("argv\n got %q\nwant %q", got, want)
		}
	})
}

func TestRunArgsDefaultsAndOverrides(t *testing.T) {
	t.Run("FR-JUDGE-03: wall time defaults to 3T+1s", func(t *testing.T) {
		s := validSpec()
		s.TimeLimit = 1500 * time.Millisecond
		got, _ := RunArgs(1, "/m", s)
		if !contains(got, "--wall-time=5.500") {
			t.Fatalf("argv %q", got)
		}
	})
	t.Run("explicit values win over defaults", func(t *testing.T) {
		s := validSpec()
		s.WallTime, s.ExtraTime, s.StackKB, s.OpenFiles = 10*time.Second, 250*time.Millisecond, 8192, 16
		got, _ := RunArgs(1, "/m", s)
		for _, w := range []string{"--wall-time=10.000", "--extra-time=0.250", "--stack=8192", "--open-files=16"} {
			if !contains(got, w) {
				t.Fatalf("missing %s in %q", w, got)
			}
		}
	})
	t.Run("unset streams are not redirected", func(t *testing.T) {
		s := validSpec()
		s.Stdin, s.Stdout, s.Stderr, s.Dirs = "", "", "", nil
		got, _ := RunArgs(1, "/m", s)
		for _, a := range got {
			if strings.HasPrefix(a, "--std") || strings.HasPrefix(a, "--dir") {
				t.Fatalf("unexpected %s", a)
			}
		}
	})
}

func TestRunArgsNeverSharesNetOrEnv(t *testing.T) {
	t.Run("FR-JUDGE-03: no network sharing and exactly one env rule", func(t *testing.T) {
		got, _ := RunArgs(3, "/m", validSpec())
		envs := 0
		for _, a := range got {
			if a == "--" {
				break
			}
			if strings.Contains(a, "share-net") || strings.HasPrefix(a, "--full-env") || strings.HasPrefix(a, "--inherit-fds") {
				t.Fatalf("forbidden flag %s", a)
			}
			if strings.HasPrefix(a, "--env") || strings.HasPrefix(a, "-E") {
				envs++
				if a != "--env=PATH=/usr/bin:/bin" {
					t.Fatalf("env rule %s", a)
				}
			}
		}
		if envs != 1 {
			t.Fatalf("%d env rules", envs)
		}
		// Every isolate call is in cgroup mode.
		for _, args := range [][]string{got, InitArgs(3), CleanupArgs(3)} {
			if !contains(args, "--cg") {
				t.Fatalf("no --cg in %q", args)
			}
		}
	})
}

func TestValidateRejects(t *testing.T) {
	cases := map[string]func(*RunSpec){
		"zero time":            func(s *RunSpec) { s.TimeLimit = 0 },
		"negative extra":       func(s *RunSpec) { s.ExtraTime = -time.Second },
		"wall below time":      func(s *RunSpec) { s.WallTime = time.Second },
		"zero memory":          func(s *RunSpec) { s.MemKB = 0 },
		"zero processes":       func(s *RunSpec) { s.Processes = 0 },
		"zero fsize":           func(s *RunSpec) { s.FsizeKB = 0 },
		"negative stack":       func(s *RunSpec) { s.StackKB = -1 },
		"negative open files":  func(s *RunSpec) { s.OpenFiles = -1 },
		"empty command":        func(s *RunSpec) { s.Cmd = nil },
		"empty argv0":          func(s *RunSpec) { s.Cmd = []string{""} },
		"NUL in command":       func(s *RunSpec) { s.Cmd = []string{"./main", "a\x00b"} },
		"relative dir":         func(s *RunSpec) { s.Dirs = []string{"usr/lib"} },
		"unclean dir":          func(s *RunSpec) { s.Dirs = []string{"/usr/lib/../../etc"} },
		"rw option":            func(s *RunSpec) { s.Dirs = []string{"/usr/lib:rw"} },
		"dev option":           func(s *RunSpec) { s.Dirs = []string{"/usr/lib:dev"} },
		"in=out mapping":       func(s *RunSpec) { s.Dirs = []string{"/box=/etc"} },
		"root bind":            func(s *RunSpec) { s.Dirs = []string{"/"} },
		"etc bind":             func(s *RunSpec) { s.Dirs = []string{"/etc"} },
		"proc subtree":         func(s *RunSpec) { s.Dirs = []string{"/proc/1"} },
		"var subtree":          func(s *RunSpec) { s.Dirs = []string{"/var/local/lib/isolate"} },
		"stdin with slash":     func(s *RunSpec) { s.Stdin = "../in.txt" },
		"stdout dotdot":        func(s *RunSpec) { s.Stdout = ".." },
		"stderr absolute path": func(s *RunSpec) { s.Stderr = "/etc/passwd" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			s := validSpec()
			mutate(&s)
			if err := s.Validate(); !errors.Is(err, ErrInvalidSpec) {
				t.Fatalf("want ErrInvalidSpec, got %v", err)
			}
			if _, err := RunArgs(1, "/m", s); err == nil {
				t.Fatal("RunArgs accepted an invalid spec")
			}
		})
	}
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
