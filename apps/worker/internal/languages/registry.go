// Package languages is the judge's language registry (SD-§8.3) and the
// sandboxed compile step (FR-JUDGE-01, FR-JUDGE-02).
package languages

import (
	"bytes"
	_ "embed"
	"fmt"
	"path"
	"slices"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

//go:embed languages.yaml
var embedded []byte

// MaxSourceBytes caps submitted source (SD §2 sizing, 64 KB).
const MaxSourceBytes = 64 << 10

// CompileLimits apply to every compile step.
type CompileLimits struct {
	CPUSeconds int   `yaml:"cpuSeconds"`
	MemMB      int64 `yaml:"memMb"`
	FsizeKB    int64 `yaml:"fsizeKb"`
	Processes  int   `yaml:"processes"`
	LogKB      int64 `yaml:"logKb"`
}

// Language is one registry entry.
type Language struct {
	ID             contracts.Language `yaml:"id"`
	Name           string             `yaml:"name"`
	SourceFile     string             `yaml:"sourceFile"`
	Compile        []string           `yaml:"compile"`
	Run            []string           `yaml:"run"`
	Artifacts      []string           `yaml:"artifacts"`
	Dirs           []string           `yaml:"dirs"`
	Processes      int                `yaml:"processes"`
	MemOverheadMB  int64              `yaml:"memOverheadMb"`
	TimeMultiplier float64            `yaml:"timeMultiplier"`
	// OOMMarkers: a runtime error whose stderr contains one of these is MLE,
	// not RE. Managed runtimes (JVM -Xmx, V8) raise their own out-of-memory
	// error before the cgroup limit is hit.
	OOMMarkers []string `yaml:"oomMarkers"`
}

// Registry holds the parsed registry.
type Registry struct {
	Limits    CompileLimits
	languages map[contracts.Language]*Language
	order     []contracts.Language
}

type file struct {
	Compile   CompileLimits `yaml:"compile"`
	Languages []*Language   `yaml:"languages"`
}

// Default parses the embedded languages.yaml.
func Default() (*Registry, error) { return Parse(embedded) }

// Parse reads a registry, rejecting unknown keys and invalid entries.
func Parse(data []byte) (*Registry, error) {
	var f file
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("languages: %w", err)
	}
	c := f.Compile
	if c.CPUSeconds <= 0 || c.MemMB <= 0 || c.FsizeKB <= 0 || c.Processes <= 0 || c.LogKB <= 0 {
		return nil, fmt.Errorf("languages: compile limits must all be positive")
	}
	r := &Registry{Limits: c, languages: map[contracts.Language]*Language{}}
	for _, l := range f.Languages {
		if err := l.validate(); err != nil {
			return nil, fmt.Errorf("languages: %s: %w", l.ID, err)
		}
		if _, dup := r.languages[l.ID]; dup {
			return nil, fmt.Errorf("languages: duplicate id %s", l.ID)
		}
		r.languages[l.ID] = l
		r.order = append(r.order, l.ID)
	}
	return r, nil
}

func (l *Language) validate() error {
	switch {
	case l.ID == "":
		return fmt.Errorf("missing id")
	case l.SourceFile == "" || strings.ContainsAny(l.SourceFile, "/\x00") || l.SourceFile == "." || l.SourceFile == "..":
		return fmt.Errorf("bad sourceFile %q", l.SourceFile)
	case len(l.Compile) == 0 || len(l.Run) == 0:
		return fmt.Errorf("compile and run commands are required")
	case len(l.Artifacts) == 0:
		return fmt.Errorf("artifacts are required")
	case l.Processes <= 0 || l.MemOverheadMB < 0 || l.TimeMultiplier <= 0:
		return fmt.Errorf("bad processes, memOverheadMb or timeMultiplier")
	}
	for _, a := range l.Artifacts {
		if _, err := path.Match(a, "x"); err != nil || strings.ContainsAny(a, "/\x00") || strings.Count(a, "*") > 1 {
			return fmt.Errorf("bad artifact pattern %q", a)
		}
	}
	// Reuse the sandbox's own checks on the command and binds.
	probe := sandbox.RunSpec{TimeLimit: time.Second, MemKB: 1, Processes: l.Processes, FsizeKB: 1, Cmd: l.Run, Dirs: l.Dirs}
	return probe.Validate()
}

// IDs lists the language ids in registry order.
func (r *Registry) IDs() []contracts.Language { return slices.Clone(r.order) }

// Get returns a language, or false if it is not in the registry.
func (r *Registry) Get(id contracts.Language) (*Language, bool) {
	l, ok := r.languages[id]
	return l, ok
}

// matchArtifact reports whether a compiled file name is one of the artifacts.
func (l *Language) matchArtifact(name string) bool {
	for _, p := range l.Artifacts {
		if ok, _ := path.Match(p, name); ok {
			return true
		}
	}
	return false
}

// RunSpec builds the run-step sandbox spec for a problem's limits
// (FR-JUDGE-03). T = limit x multiplier; memory gets the runtime overhead.
func (l *Language) RunSpec(lim contracts.Limits, stdin, stdout, stderr string) sandbox.RunSpec {
	cmd := make([]string, len(l.Run))
	for i, a := range l.Run {
		cmd[i] = strings.ReplaceAll(a, "{MEM_MB}", fmt.Sprint(lim.MemMB))
	}
	return sandbox.RunSpec{
		TimeLimit: time.Duration(float64(lim.TimeMS) * l.TimeMultiplier * float64(time.Millisecond)),
		MemKB:     (lim.MemMB + l.MemOverheadMB) * 1024,
		Processes: l.Processes,
		// One KB over the output limit, so the judge can tell "wrote exactly
		// the limit" from "was cut off at the limit" (OLE): see judge.MapRun.
		FsizeKB: lim.OutputKB + 1,
		Dirs:    l.Dirs,
		Stdin:   stdin,
		Stdout:  stdout,
		Stderr:  stderr,
		Cmd:     cmd,
	}
}
