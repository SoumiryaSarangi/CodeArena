package languages

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

// Files written by the compile step inside the compile box.
const (
	compileStdout = "compile.out"
	compileStderr = "compile.err"
	// maxArtifactBytes caps one artifact; maxTotalArtifactBytes all of them.
	maxArtifactBytes      = 32 << 20
	maxTotalArtifactBytes = 48 << 20
)

// ErrSourceTooLarge is returned for source over MaxSourceBytes.
var ErrSourceTooLarge = errors.New("languages: source too large")

// Artifact is one compiled file, read safely from the compile box.
type Artifact struct {
	Name string
	Data []byte
}

// CompileResult is the outcome of the sandboxed compile step.
type CompileResult struct {
	OK        bool
	Log       string // compiler output, at most LogKB; the CE log when !OK
	Meta      sandbox.Meta
	Artifacts []Artifact
}

// Compile writes source into a freshly initialised compile box, runs the
// language's compile command there with the compile limits (FR-JUDGE-02), and
// reads the artifacts back with the safe reader. A non-zero exit, a signal or
// a limit hit is a compile error (CE), not an error return; an error return
// means the sandbox itself failed (SE).
func (r *Registry) Compile(ctx context.Context, box *sandbox.Box, l *Language, source string) (*CompileResult, error) {
	return r.CompileWith(ctx, box, l, source, nil)
}

// File is an extra file placed next to the source (a vendored header).
type File struct {
	Name string
	Data []byte
}

// CompileWith is Compile with extra files written beside the source, used for
// testlib checkers (testlib.h). Extra files are trusted host data, not source.
func (r *Registry) CompileWith(ctx context.Context, box *sandbox.Box, l *Language, source string, extra []File) (*CompileResult, error) {
	if len(source) > MaxSourceBytes {
		return nil, ErrSourceTooLarge
	}
	if err := box.Init(ctx); err != nil {
		return nil, err
	}
	if err := box.WriteFile(l.SourceFile, []byte(source), 0o644); err != nil {
		return nil, fmt.Errorf("languages: write source: %w", err)
	}
	for _, f := range extra {
		if err := box.WriteFile(f.Name, f.Data, 0o644); err != nil {
			return nil, fmt.Errorf("languages: write %s: %w", f.Name, err)
		}
	}
	meta, err := box.Run(ctx, r.compileSpec(l))
	if err != nil {
		return nil, err
	}
	res := &CompileResult{Meta: meta, Log: r.readLog(box, meta)}
	if meta.Status != sandbox.StatusOK || meta.OOMKilled {
		return res, nil
	}
	arts, err := collect(box, l)
	if err != nil {
		// A missing or unsafe artifact after a "successful" compile means
		// the submission tampered with the box or the compiler misbehaved.
		res.Log = strings.TrimSpace(res.Log + "\n" + err.Error())
		return res, nil
	}
	res.OK, res.Artifacts = true, arts
	return res, nil
}

// compileSpec is the sandbox spec for a compile step: the registry's compile
// limits (FR-JUDGE-02), the language's binds, output into compile.out/err.
// Wall time and open files take the sandbox defaults (3T+1 s, 64).
func (r *Registry) compileSpec(l *Language) sandbox.RunSpec {
	c := r.Limits
	return sandbox.RunSpec{
		TimeLimit: time.Duration(c.CPUSeconds) * time.Second,
		MemKB:     c.MemMB * 1024,
		Processes: c.Processes,
		FsizeKB:   c.FsizeKB,
		Dirs:      l.Dirs,
		Stdout:    compileStdout,
		Stderr:    compileStderr,
		Cmd:       l.Compile,
	}
}

// readLog joins compiler stdout and stderr, each capped, and adds the limit
// that was hit so a CE always explains itself.
func (r *Registry) readLog(box *sandbox.Box, m sandbox.Meta) string {
	limit := r.Limits.LogKB * 1024
	var parts []string
	for _, name := range []string{compileStderr, compileStdout} {
		data, trunc, err := box.ReadFile(name, limit)
		if err != nil || len(data) == 0 {
			continue
		}
		s := strings.ToValidUTF8(string(data), "�")
		if trunc {
			s += "\n[output truncated]"
		}
		parts = append(parts, s)
	}
	switch {
	case m.OOMKilled:
		parts = append(parts, "compilation ran out of memory")
	case m.Status == sandbox.StatusTO:
		parts = append(parts, "compilation timed out")
	case m.Status == sandbox.StatusSG:
		parts = append(parts, "compiler killed by "+m.Signal())
	}
	log := strings.Join(parts, "\n")
	if int64(len(log)) > limit {
		log = log[:limit]
	}
	return strings.ToValidUTF8(log, "�")
}

func collect(box *sandbox.Box, l *Language) ([]Artifact, error) {
	names, err := sandbox.ListFiles(box.Dir())
	if err != nil {
		return nil, err
	}
	var out []Artifact
	var total int
	for _, n := range names {
		if !l.matchArtifact(n) {
			continue
		}
		data, trunc, err := box.ReadFile(n, maxArtifactBytes)
		if err != nil {
			return nil, fmt.Errorf("artifact %s: %w", n, err)
		}
		if trunc {
			return nil, fmt.Errorf("artifact %s is larger than %d MB", n, maxArtifactBytes>>20)
		}
		if total += len(data); total > maxTotalArtifactBytes {
			return nil, fmt.Errorf("artifacts are larger than %d MB", maxTotalArtifactBytes>>20)
		}
		out = append(out, Artifact{Name: n, Data: data})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("compiler produced no %s", strings.Join(l.Artifacts, ", "))
	}
	return out, nil
}

// Install copies compiled artifacts into a freshly initialised run box and
// marks them executable (the host writes only with O_EXCL, never following
// anything in the box).
func Install(ctx context.Context, box *sandbox.Box, arts []Artifact) error {
	if err := box.Init(ctx); err != nil {
		return err
	}
	for _, a := range arts {
		if err := box.WriteFile(a.Name, a.Data, 0o755); err != nil {
			return fmt.Errorf("languages: install %s: %w", a.Name, err)
		}
	}
	return nil
}
