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

// RunArgs are the isolate arguments for one run (SD-§8.2). metaPath is a host
// path outside the box.
func RunArgs(id int, metaPath string, spec RunSpec) ([]string, error) {
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
	for _, d := range s.Dirs {
		args = append(args, "--dir="+d)
	}
	args = append(args, "--")
	return append(args, s.Cmd...), nil
}

func seconds(d time.Duration) string {
	return strconv.FormatFloat(d.Seconds(), 'f', 3, 64)
}
