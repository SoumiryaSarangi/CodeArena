package sandbox

import (
	"strconv"
	"time"
)

// InitArgs are the isolate arguments that create (or reset) box id.
func InitArgs(id int) []string {
	return []string{"--box-id=" + strconv.Itoa(id), "--cg", "--init"}
}

// CleanupArgs are the isolate arguments that destroy box id and kill anything
// left in its cgroup.
func CleanupArgs(id int) []string {
	return []string{"--box-id=" + strconv.Itoa(id), "--cg", "--cleanup"}
}

// RunOptions are per-pool settings that apply to every run.
type RunOptions struct {
	// DevDir replaces isolate's default /dev rule, which binds the host's
	// whole /dev with device access, by a prepared directory holding only
	// null, zero, full, random, urandom, the fd/std* symlinks and an empty
	// shm/ (J-08; see scripts/setup-isolate-wsl.sh). Empty keeps the default.
	DevDir string
}

// RunArgs are the isolate arguments for one run (SD-§8.2). metaPath is a host
// path outside the box.
func RunArgs(id int, metaPath string, spec RunSpec, opts RunOptions) ([]string, error) {
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	s := spec.withDefaults()
	args := []string{
		"--box-id=" + strconv.Itoa(id),
		"--cg",
		"--run",
		"--meta=" + metaPath,
		"--time=" + seconds(s.TimeLimit),
		"--extra-time=" + seconds(s.ExtraTime),
		"--wall-time=" + seconds(s.WallTime),
		"--cg-mem=" + strconv.FormatInt(s.MemKB, 10),
		"--processes=" + strconv.Itoa(s.Processes),
		"--fsize=" + strconv.FormatInt(s.FsizeKB, 10),
		"--stack=" + strconv.FormatInt(s.StackKB, 10),
		"--open-files=" + strconv.Itoa(s.OpenFiles),
		"--env=PATH=" + SandboxPATH,
	}
	if s.Stdin != "" {
		args = append(args, "--stdin="+s.Stdin)
	}
	if s.Stdout != "" {
		args = append(args, "--stdout="+s.Stdout)
	}
	if s.Stderr != "" {
		args = append(args, "--stderr="+s.Stderr)
	}
	if opts.DevDir != "" {
		// Delete the default rule first, then bind the prepared directory.
		args = append(args, "--dir=dev=", "--dir=dev="+opts.DevDir+":dev")
	}
	for _, d := range s.Dirs {
		args = append(args, "--dir="+d)
	}
	args = append(args, "--")
	return append(args, s.Cmd...), nil
}

func seconds(d time.Duration) string {
	return strconv.FormatFloat(d.Seconds(), 'f', 3, 64)
}
