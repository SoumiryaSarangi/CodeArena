// Package problempkg loads and checks problem packages (SRS §3.1.6) and turns
// their tests into the flat NN.in/NN.ans tar the judge's test cache expects.
package problempkg

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

// Limits from SRS §3.1.6 and the sandbox.
const (
	MaxTestsBytes = 50 << 20
	MaxTests      = 99
)

var (
	slugRe   = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	testRe   = regexp.MustCompile(`^([0-9]{2})\.(in|ans)$`)
	sectionR = regexp.MustCompile(`(?m)^## (Input|Output|Notes)\s*$`)
)

// Solution is one declared solution and the verdict it must receive.
type Solution struct {
	File     string            `yaml:"file"`
	Expected contracts.Verdict `yaml:"expected"`
}

// Meta is problem.yaml.
type Meta struct {
	Title          string   `yaml:"title"`
	Rating         int      `yaml:"rating"`
	PracticePoints int      `yaml:"practicePoints"`
	Tags           []string `yaml:"tags"`
	Limits         struct {
		TimeMS   int64 `yaml:"timeMs"`
		MemMB    int64 `yaml:"memMb"`
		OutputKB int64 `yaml:"outputKb"`
	} `yaml:"limits"`
	Checker struct {
		Kind contracts.CheckerKind `yaml:"kind"`
		Eps  *float64              `yaml:"eps"`
	} `yaml:"checker"`
	Samples   []string         `yaml:"samples"`
	AvoidSet  map[int][]string `yaml:"avoidSet"`
	Generator string           `yaml:"generator"`
	Solutions []Solution       `yaml:"solutions"`
}

// Test is one input/answer pair.
type Test struct {
	No  int
	In  []byte
	Ans []byte
}

// Package is a loaded, structurally valid problem package.
type Package struct {
	Dir   string
	Slug  string
	Meta  Meta
	Tests []Test
}

// Limits returns the judge limits.
func (p *Package) Limits() contracts.Limits {
	return contracts.Limits{TimeMS: p.Meta.Limits.TimeMS, MemMB: p.Meta.Limits.MemMB, OutputKB: p.Meta.Limits.OutputKB}
}

// Checker returns the judge checker description (testlib sources are
// compiled by the caller from checker.cpp).
func (p *Package) Checker() contracts.Checker {
	return contracts.Checker{Kind: p.Meta.Checker.Kind, Eps: p.Meta.Checker.Eps}
}

// Load reads a package and returns every structural problem at once.
func Load(dir string) (*Package, error) {
	dir = filepath.Clean(dir)
	p := &Package{Dir: dir, Slug: filepath.Base(dir)}
	var errs []error
	add := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if !slugRe.MatchString(p.Slug) {
		add("directory name %q is not a slug (lowercase words joined by '-')", p.Slug)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "problem.yaml"))
	if err != nil {
		return nil, fmt.Errorf("problem.yaml: %w", err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&p.Meta); err != nil {
		return nil, fmt.Errorf("problem.yaml: %w", err)
	}
	errs = append(errs, p.checkMeta()...)

	for _, f := range []string{"statement.md", "editorial.md", "validator.cpp"} {
		if fi, err := os.Stat(filepath.Join(dir, f)); err != nil || !fi.Mode().IsRegular() {
			add("%s is missing", f)
		}
	}
	if st, err := os.ReadFile(filepath.Join(dir, "statement.md")); err == nil {
		errs = append(errs, checkStatement(string(st))...)
	}
	if p.Meta.Checker.Kind == contracts.CheckerKindTestlib {
		if fi, err := os.Stat(filepath.Join(dir, "checker.cpp")); err != nil || !fi.Mode().IsRegular() {
			add("checker kind is testlib but checker.cpp is missing")
		}
	} else if _, err := os.Stat(filepath.Join(dir, "checker.cpp")); err == nil {
		add("checker.cpp exists but the checker kind is %q", p.Meta.Checker.Kind)
	}

	tests, terrs := loadTests(filepath.Join(dir, "tests"))
	errs = append(errs, terrs...)
	p.Tests = tests
	errs = append(errs, p.checkSamples()...)
	errs = append(errs, p.checkSolutions()...)
	if len(errs) > 0 {
		return p, errors.Join(errs...)
	}
	return p, nil
}

func (p *Package) checkMeta() []error {
	var errs []error
	add := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }
	m := p.Meta
	switch {
	case strings.TrimSpace(m.Title) == "" || len(m.Title) > 100:
		add("title must be 1-100 characters")
	}
	if m.Rating < 800 || m.Rating > 3500 || m.Rating%100 != 0 {
		add("rating must be a multiple of 100 between 800 and 3500, got %d", m.Rating)
	}
	if m.PracticePoints != m.Rating/100 {
		add("practicePoints must be rating/100 (PRD Q5): want %d, got %d", m.Rating/100, m.PracticePoints)
	}
	if len(m.Tags) == 0 {
		add("at least one tag is required")
	}
	if m.Limits.TimeMS < 100 || m.Limits.TimeMS > 10000 || m.Limits.MemMB < 16 || m.Limits.MemMB > 1024 ||
		m.Limits.OutputKB < 1 || m.Limits.OutputKB > 65536 {
		add("limits out of range (timeMs 100-10000, memMb 16-1024, outputKb 1-65536)")
	}
	switch m.Checker.Kind {
	case contracts.CheckerKindExact, contracts.CheckerKindTokens, contracts.CheckerKindTestlib:
		if m.Checker.Eps != nil {
			add("eps is only for the float checker")
		}
	case contracts.CheckerKindFloat:
		if m.Checker.Eps == nil || *m.Checker.Eps <= 0 {
			add("the float checker needs a positive eps")
		}
	default:
		add("unknown checker kind %q", m.Checker.Kind)
	}
	for lvl := range m.AvoidSet {
		if lvl != 1 && lvl != 2 {
			add("avoidSet has level %d; only 1 and 2 exist", lvl)
		}
	}
	return errs
}

func checkStatement(md string) []error {
	got := map[string]bool{}
	for _, m := range sectionR.FindAllStringSubmatch(md, -1) {
		got[m[1]] = true
	}
	var errs []error
	for _, s := range []string{"Input", "Output", "Notes"} {
		if !got[s] {
			errs = append(errs, fmt.Errorf("statement.md has no '## %s' section", s))
		}
	}
	if !strings.HasPrefix(strings.TrimSpace(md), "# ") {
		errs = append(errs, errors.New("statement.md must start with a '# Title' heading"))
	}
	return errs
}

func loadTests(dir string) ([]Test, []error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, []error{fmt.Errorf("tests/: %w", err)}
	}
	var errs []error
	files := map[string][]byte{}
	var total int64
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || !testRe.MatchString(name) {
			errs = append(errs, fmt.Errorf("tests/%s: not a regular NN.in or NN.ans file", name))
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			errs = append(errs, err)
			continue
		}
		total += int64(len(b))
		files[name] = b
	}
	if total > MaxTestsBytes {
		errs = append(errs, fmt.Errorf("tests are %d bytes, over the %d MB limit", total, MaxTestsBytes>>20))
	}
	var nos []int
	for name := range files {
		if m := testRe.FindStringSubmatch(name); m[2] == "in" {
			var n int
			fmt.Sscanf(m[1], "%d", &n)
			nos = append(nos, n)
		}
	}
	sort.Ints(nos)
	if len(nos) == 0 {
		return nil, append(errs, errors.New("tests/ has no tests"))
	}
	if len(nos) > MaxTests {
		errs = append(errs, fmt.Errorf("more than %d tests", MaxTests))
	}
	var tests []Test
	for i, n := range nos {
		if n != i+1 {
			errs = append(errs, fmt.Errorf("test numbering has a gap: expected %02d, found %02d", i+1, n))
			break
		}
		in, ans := fmt.Sprintf("%02d.in", n), fmt.Sprintf("%02d.ans", n)
		if _, ok := files[ans]; !ok {
			errs = append(errs, fmt.Errorf("tests/%s has no matching .ans", in))
			continue
		}
		tests = append(tests, Test{No: n, In: files[in], Ans: files[ans]})
	}
	for name := range files {
		m := testRe.FindStringSubmatch(name)
		if m[2] == "ans" {
			if _, ok := files[m[1]+".in"]; !ok {
				errs = append(errs, fmt.Errorf("tests/%s has no matching .in", name))
			}
		}
	}
	return tests, errs
}

func (p *Package) checkSamples() []error {
	var errs []error
	if len(p.Meta.Samples) == 0 {
		return []error{errors.New("samples: at least one sample is required")}
	}
	for i, s := range p.Meta.Samples {
		if s != fmt.Sprintf("%02d", i+1) {
			errs = append(errs, fmt.Errorf("samples must be the first tests in order (01, 02, ...); sample %d is %q", i+1, s))
		}
	}
	if len(p.Meta.Samples) > len(p.Tests) {
		errs = append(errs, errors.New("samples lists more tests than exist"))
	}
	return errs
}

var extLang = map[string]contracts.Language{
	".c": contracts.LanguageC, ".cpp": contracts.LanguageCpp17, ".py": contracts.LanguagePython3,
	".java": contracts.LanguageJava21, ".js": contracts.LanguageNode,
}

// LanguageOf maps a solution file to its judge language.
func LanguageOf(file string) (contracts.Language, bool) {
	l, ok := extLang[strings.ToLower(filepath.Ext(file))]
	return l, ok
}

func (p *Package) checkSolutions() []error {
	var errs []error
	hasAC := false
	declared := map[string]bool{}
	valid := map[contracts.Verdict]bool{"AC": true, "WA": true, "TLE": true, "MLE": true, "RE": true, "OLE": true, "CE": true}
	for _, s := range p.Meta.Solutions {
		switch {
		case s.File == "" || strings.ContainsAny(s.File, "/\\") || s.File == "." || s.File == "..":
			errs = append(errs, fmt.Errorf("solution %q: file must be a plain name inside solutions/", s.File))
			continue
		case !valid[s.Expected]:
			errs = append(errs, fmt.Errorf("solution %s: expected verdict %q is not one of AC WA TLE MLE RE OLE CE", s.File, s.Expected))
			continue
		case declared[s.File]:
			errs = append(errs, fmt.Errorf("solution %s is declared twice", s.File))
			continue
		}
		if _, ok := LanguageOf(s.File); !ok {
			errs = append(errs, fmt.Errorf("solution %s: unknown language extension", s.File))
		}
		if fi, err := os.Stat(filepath.Join(p.Dir, "solutions", s.File)); err != nil || !fi.Mode().IsRegular() {
			errs = append(errs, fmt.Errorf("solution %s is declared but missing", s.File))
		}
		declared[s.File] = true
		hasAC = hasAC || s.Expected == contracts.VerdictAC
	}
	if !hasAC {
		errs = append(errs, errors.New("solutions: at least one must be expected AC"))
	}
	if entries, err := os.ReadDir(filepath.Join(p.Dir, "solutions")); err == nil {
		for _, e := range entries {
			if !declared[e.Name()] {
				errs = append(errs, fmt.Errorf("solutions/%s has no expected verdict in problem.yaml", e.Name()))
			}
		}
	} else {
		errs = append(errs, fmt.Errorf("solutions/: %w", err))
	}
	return errs
}

// Tar returns the testset archive the judge fetches (flat NN.in/NN.ans,
// sorted, fixed metadata so the SHA-256 is reproducible) and its hash, which
// is the job's testsetHash.
func (p *Package) Tar() (data []byte, hash string, err error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, t := range p.Tests {
		for _, f := range []struct {
			name string
			body []byte
		}{{fmt.Sprintf("%02d.in", t.No), t.In}, {fmt.Sprintf("%02d.ans", t.No), t.Ans}} {
			h := &tar.Header{Name: f.name, Mode: 0o644, Size: int64(len(f.body)), Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}
			if err := tw.WriteHeader(h); err != nil {
				return nil, "", err
			}
			if _, err := tw.Write(f.body); err != nil {
				return nil, "", err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(sum[:]), nil
}

// Read returns a package file's contents.
func (p *Package) Read(rel string) (string, error) {
	b, err := os.ReadFile(filepath.Join(p.Dir, rel))
	return string(b), err
}
