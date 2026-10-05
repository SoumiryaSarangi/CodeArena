package sandbox

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// ErrSandbox means isolate itself failed (exit code 2, status XX, or an
// unexpected exit). The judge reports it as SE and retries the job.
var ErrSandbox = errors.New("sandbox: isolate failed")

// ErrNotInitialized is returned by box file operations before Init.
var ErrNotInitialized = errors.New("sandbox: box not initialized")

// maxCmdOutput caps what is kept of isolate's own stdout/stderr.
const maxCmdOutput = 16 << 10

// ExecResult is the outcome of one isolate invocation.
type ExecResult struct {
	Code   int
	Stdout []byte
	Stderr []byte
}

// Executor runs a command line. Err is only for failing to start or wait;
// a non-zero exit is reported in Code.
type Executor interface {
	Exec(ctx context.Context, argv []string) (ExecResult, error)
}

type execExecutor struct{}

func (execExecutor) Exec(ctx context.Context, argv []string) (ExecResult, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = []string{}
	var stdout, stderr cappedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := ExecResult{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && ctx.Err() == nil {
		res.Code = exitErr.ExitCode()
		return res, nil
	}
	if err != nil {
		return res, err
	}
	return res, nil
}

// cappedBuffer keeps the first maxCmdOutput bytes and drops the rest.
type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := maxCmdOutput - b.Len(); room > 0 {
		if len(p) > room {
			b.Buffer.Write(p[:room])
		} else {
			b.Buffer.Write(p)
		}
	}
	return len(p), nil
}

// runner holds what every box needs to call isolate.
type runner struct {
	isolate string
	taskset string
	exec    Executor
	metaDir string
}

func (r *runner) call(ctx context.Context, core int, args []string) (ExecResult, error) {
	argv := append([]string{r.taskset, "-c", strconv.Itoa(core), r.isolate}, args...)
	return r.exec.Exec(ctx, argv)
}

// Box is one isolate box pinned to a core.
type Box struct {
	ID   int
	Core int
	r    *runner
	dir  string // host path of box/, set by Init
}

// Dir is the host path of the box directory, or "" before Init.
func (b *Box) Dir() string { return b.dir }

func (b *Box) metaPath() string {
	return filepath.Join(b.r.metaDir, strconv.Itoa(b.ID)+".meta")
}

// Init creates a fresh, empty box. Re-initialising an existing box empties it.
func (b *Box) Init(ctx context.Context) error {
	res, err := b.r.call(ctx, b.Core, InitArgs(b.ID))
	if err != nil {
		return fmt.Errorf("%w: init box %d: %v", ErrSandbox, b.ID, err)
	}
	if res.Code != 0 {
		return sandboxErr("init", b.ID, res)
	}
	root := strings.TrimSpace(string(res.Stdout))
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return fmt.Errorf("%w: init box %d: unexpected path %q", ErrSandbox, b.ID, root)
	}
	b.dir = filepath.Join(root, "box")
	return nil
}

// Cleanup destroys the box and kills anything left in its cgroup.
func (b *Box) Cleanup(ctx context.Context) error {
	b.dir = ""
	res, err := b.r.call(ctx, b.Core, CleanupArgs(b.ID))
	if err != nil {
		return fmt.Errorf("%w: cleanup box %d: %v", ErrSandbox, b.ID, err)
	}
	if res.Code != 0 {
		return sandboxErr("cleanup", b.ID, res)
	}
	return nil
}

// Run executes spec in the box and returns isolate's meta. A program that
// fails (RE, SG, TO) is not an error; isolate failing is ErrSandbox.
func (b *Box) Run(ctx context.Context, spec RunSpec) (Meta, error) {
	if b.dir == "" {
		return Meta{}, ErrNotInitialized
	}
	metaPath := b.metaPath()
	if err := os.Remove(metaPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Meta{}, err
	}
	args, err := RunArgs(b.ID, metaPath, spec)
	if err != nil {
		return Meta{}, err
	}
	res, err := b.r.call(ctx, b.Core, args)
	if err != nil {
		return Meta{}, fmt.Errorf("%w: run box %d: %v", ErrSandbox, b.ID, err)
	}
	// isolate exits 0 when the program succeeded and 1 when it failed;
	// anything else is isolate's own failure.
	if res.Code != 0 && res.Code != 1 {
		return Meta{}, sandboxErr("run", b.ID, res)
	}
	raw, truncated, err := ReadFile(b.r.metaDir, filepath.Base(metaPath), MaxMetaBytes)
	if err != nil {
		return Meta{}, fmt.Errorf("%w: run box %d: meta: %v", ErrSandbox, b.ID, err)
	}
	if truncated {
		return Meta{}, fmt.Errorf("%w: run box %d: meta too large", ErrSandbox, b.ID)
	}
	m, err := ParseMeta(bytes.NewReader(raw))
	if err != nil {
		return Meta{}, fmt.Errorf("%w: run box %d: %v", ErrSandbox, b.ID, err)
	}
	if m.Status == StatusInternal {
		return m, fmt.Errorf("%w: run box %d: %s", ErrSandbox, b.ID, m.Message)
	}
	return m, nil
}

// WriteFile creates a new file in the box (O_EXCL, never follows links).
func (b *Box) WriteFile(name string, data []byte, perm os.FileMode) error {
	if b.dir == "" {
		return ErrNotInitialized
	}
	return WriteFileExcl(b.dir, name, data, perm)
}

// ReadFile reads a box file safely, returning at most limit bytes.
func (b *Box) ReadFile(name string, limit int64) ([]byte, bool, error) {
	if b.dir == "" {
		return nil, false, ErrNotInitialized
	}
	return ReadFile(b.dir, name, limit)
}

func sandboxErr(op string, id int, res ExecResult) error {
	msg := strings.TrimSpace(string(res.Stderr))
	return fmt.Errorf("%w: %s box %d: exit %d: %s", ErrSandbox, op, id, res.Code, msg)
}
