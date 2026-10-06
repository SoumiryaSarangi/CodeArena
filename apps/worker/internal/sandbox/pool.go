package sandbox

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// BoxesPerSlot: compile, run and checker boxes share a slot's core (SD-§8.1).
const BoxesPerSlot = 3

// Config sets up a Pool. Zero values pick the defaults.
type Config struct {
	Cores       []int    // one slot per core; default 0..NumCPU-1
	BoxIDBase   int      // first box id; slot i uses base+3i .. base+3i+2
	IsolatePath string   // default "isolate" on PATH
	TasksetPath string   // default "taskset" on PATH
	MetaDir     string   // worker-owned dir for meta files; default a new temp dir
	Exec        Executor // default runs the real binaries
	// DevDir is the prepared /dev bound into every box (J-08). Default
	// DefaultDevDir. "-" keeps isolate's default /dev rule (tests only).
	DevDir string
}

// DefaultDevDir is created by scripts/setup-isolate-wsl.sh (and the judge VM
// cloud-init): device nodes null, zero, full, random, urandom; fd/stdin/
// stdout/stderr symlinks into /proc/self/fd; an empty shm/ for isolate's tmpfs.
const DefaultDevDir = "/var/local/lib/codearena/box-dev"

// Slot is one core's worth of boxes, handed to one job at a time.
type Slot struct {
	Core    int
	Compile *Box
	Run     *Box
	Checker *Box
}

func (s *Slot) boxes() []*Box { return []*Box{s.Compile, s.Run, s.Checker} }

// Pool hands out slots, one job per core at a time.
type Pool struct {
	free        chan *Slot
	all         []*Slot
	r           *runner
	ownsMetaDir bool
}

// New checks the binaries, prepares the meta dir and clears any boxes a
// crashed worker left behind.
func New(ctx context.Context, cfg Config) (*Pool, error) {
	cores := cfg.Cores
	if len(cores) == 0 {
		for i := 0; i < runtime.NumCPU(); i++ {
			cores = append(cores, i)
		}
	}
	seen := map[int]bool{}
	for _, c := range cores {
		if c < 0 || seen[c] {
			return nil, fmt.Errorf("sandbox: bad or duplicate core %d", c)
		}
		seen[c] = true
	}
	if cfg.BoxIDBase < 0 {
		return nil, fmt.Errorf("sandbox: negative box id base")
	}

	r := &runner{exec: cfg.Exec}
	switch cfg.DevDir {
	case "":
		r.devDir = DefaultDevDir
	case "-":
		r.devDir = ""
	default:
		r.devDir = cfg.DevDir
	}
	if r.devDir != "" && cfg.Exec == nil {
		if err := checkDevDir(r.devDir); err != nil {
			return nil, err
		}
	}
	var err error
	if r.isolate, err = resolveBinary(cfg.IsolatePath, "isolate", cfg.Exec != nil); err != nil {
		return nil, err
	}
	if r.taskset, err = resolveBinary(cfg.TasksetPath, "taskset", cfg.Exec != nil); err != nil {
		return nil, err
	}
	if r.exec == nil {
		r.exec = execExecutor{}
	}

	p := &Pool{free: make(chan *Slot, len(cores)), r: r}
	if cfg.MetaDir != "" {
		r.metaDir = cfg.MetaDir
	} else {
		if r.metaDir, err = os.MkdirTemp("", "codearena-meta-"); err != nil {
			return nil, err
		}
		p.ownsMetaDir = true
	}

	for i, core := range cores {
		id := cfg.BoxIDBase + BoxesPerSlot*i
		s := &Slot{
			Core:    core,
			Compile: &Box{ID: id, Core: core, r: r},
			Run:     &Box{ID: id + 1, Core: core, r: r},
			Checker: &Box{ID: id + 2, Core: core, r: r},
		}
		for _, b := range s.boxes() {
			if err := b.Cleanup(ctx); err != nil {
				p.removeMetaDir()
				return nil, err
			}
		}
		p.all = append(p.all, s)
		p.free <- s
	}
	return p, nil
}

func resolveBinary(path, name string, custom bool) (string, error) {
	if path == "" {
		path = name
	}
	if custom {
		return path, nil
	}
	full, err := exec.LookPath(path)
	if err != nil {
		return "", fmt.Errorf("sandbox: %s not found: %w", name, err)
	}
	return full, nil
}

// Size is the number of slots.
func (p *Pool) Size() int { return len(p.all) }

// Acquire waits for a free slot or for ctx to end.
func (p *Pool) Acquire(ctx context.Context) (*Slot, error) {
	select {
	case s := <-p.free:
		return s, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Release cleans all three boxes and returns the slot to the pool. The slot
// goes back even if cleanup fails; the next Init re-creates the box, and the
// error is returned so the caller can log and count it.
func (p *Pool) Release(ctx context.Context, s *Slot) error {
	var errs []error
	for _, b := range s.boxes() {
		if err := b.Cleanup(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	p.free <- s
	return errors.Join(errs...)
}

// Close cleans every box (callers must have released their slots) and removes
// the meta dir if the pool created it.
func (p *Pool) Close(ctx context.Context) error {
	var errs []error
	for _, s := range p.all {
		for _, b := range s.boxes() {
			if err := b.Cleanup(ctx); err != nil {
				errs = append(errs, err)
			}
		}
	}
	p.removeMetaDir()
	return errors.Join(errs...)
}

func (p *Pool) removeMetaDir() {
	if p.ownsMetaDir {
		os.RemoveAll(p.r.metaDir)
	}
}

// checkDevDir verifies the prepared /dev exists and holds a real null device,
// so a misconfigured host fails at startup instead of on the first job.
func checkDevDir(dir string) error {
	fi, err := os.Stat(filepath.Join(dir, "null"))
	if err != nil || fi.Mode()&os.ModeCharDevice == 0 || fi.Mode()&os.ModeDevice == 0 {
		return fmt.Errorf("sandbox: %s/null is not a character device; create the box /dev with: sudo scripts/setup-isolate-wsl.sh", dir)
	}
	return nil
}
