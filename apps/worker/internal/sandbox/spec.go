package sandbox

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Defaults from SD-§8.2.
const (
	DefaultExtraTime = 500 * time.Millisecond
	DefaultOpenFiles = 64
	// SandboxPATH is the only environment variable a sandbox gets.
	SandboxPATH = "/usr/bin:/bin"
)

// ErrInvalidSpec is wrapped by every RunSpec validation error.
var ErrInvalidSpec = errors.New("sandbox: invalid run spec")

// RunSpec describes one isolate --run. Zero values for ExtraTime, WallTime,
// StackKB and OpenFiles mean "use the default".
type RunSpec struct {
	TimeLimit time.Duration // CPU time of the whole cgroup
	ExtraTime time.Duration // grace before a TO program is killed; default 0.5 s
	WallTime  time.Duration // default 3T + 1 s, guards sleeping programs
	MemKB     int64         // --cg-mem
	Processes int           // --processes
	FsizeKB   int64         // --fsize, per written file
	StackKB   int64         // --stack; default MemKB
	OpenFiles int           // --open-files; default 64

	// Dirs are extra read-only binds (language runtimes only), absolute host paths.
	Dirs []string

	// Box-relative file names for the standard streams; empty means not redirected.
	Stdin, Stdout, Stderr string

	Cmd []string
}

// withDefaults returns a copy with zero-valued optional fields filled in.
func (s RunSpec) withDefaults() RunSpec {
	if s.ExtraTime == 0 {
		s.ExtraTime = DefaultExtraTime
	}
	if s.WallTime == 0 {
		s.WallTime = 3*s.TimeLimit + time.Second
	}
	if s.StackKB == 0 {
		s.StackKB = s.MemKB
	}
	if s.OpenFiles == 0 {
		s.OpenFiles = DefaultOpenFiles
	}
	return s
}

// Validate checks a spec after defaults are applied.
func (s RunSpec) Validate() error {
	s = s.withDefaults()
	switch {
	case s.TimeLimit <= 0:
		return invalid("time limit must be positive")
	case s.ExtraTime < 0:
		return invalid("extra time must not be negative")
	case s.WallTime < s.TimeLimit:
		return invalid("wall time must be at least the time limit")
	case s.MemKB <= 0:
		return invalid("memory limit must be positive")
	case s.Processes <= 0:
		return invalid("process limit must be positive")
	case s.FsizeKB <= 0:
		return invalid("file size limit must be positive")
	case s.StackKB <= 0:
		return invalid("stack limit must be positive")
	case s.OpenFiles <= 0:
		return invalid("open files limit must be positive")
	case len(s.Cmd) == 0 || s.Cmd[0] == "":
		return invalid("command is empty")
	}
	for _, d := range s.Dirs {
		if err := checkDir(d); err != nil {
			return err
		}
	}
	for _, n := range []string{s.Stdin, s.Stdout, s.Stderr} {
		if n == "" {
			continue
		}
		if err := checkName(n); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidSpec, err)
		}
	}
	for _, a := range s.Cmd {
		if strings.ContainsRune(a, 0) {
			return invalid("command contains NUL")
		}
	}
	return nil
}

// forbiddenDirs may not be bound into a box, nor anything below them.
var forbiddenDirs = []string{"/box", "/proc", "/dev", "/sys", "/run", "/var", "/etc", "/home", "/root", "/tmp"}

// javaConfDir is the one /etc path a runtime needs: Ubuntu's JDK links its
// conf directory into /etc/java-<n>-openjdk.
var javaConfDir = regexp.MustCompile(`^/etc/java-[0-9]+-openjdk$`)

// checkDir allows only a plain, clean, absolute path: no isolate options
// (":rw", ":dev"), no "=" (in/out mapping), no root, no sensitive trees.
func checkDir(d string) error {
	if !filepath.IsAbs(d) || filepath.Clean(d) != d {
		return invalid("dir %q must be a clean absolute path", d)
	}
	if strings.ContainsAny(d, ":=,\x00") || strings.ContainsAny(d, " \t\n") {
		return invalid("dir %q contains a forbidden character", d)
	}
	if d == "/" {
		return invalid("dir must not be the root")
	}
	if javaConfDir.MatchString(d) {
		return nil
	}
	for _, f := range forbiddenDirs {
		if d == f || strings.HasPrefix(d, f+"/") {
			return invalid("dir %q is not allowed", d)
		}
	}
	return nil
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidSpec, fmt.Sprintf(format, args...))
}
