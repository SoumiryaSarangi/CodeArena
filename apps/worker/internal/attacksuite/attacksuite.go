// Package attacksuite loads sandbox-containment cases and judges their
// outcomes (J-07, FR-JUDGE-10). A case is a small program plus a case.yaml
// stating how it must end: which verdicts are acceptable (the point is that
// the program is contained, not that it "passes"), strings its output must or
// must not contain, and host-side checks the runner performs outside the box.
//
// This package only parses cases and matches outcomes. Running programs in
// isolate and the host checks live in cmd/attack, which owns the sandbox pool
// and /proc access.
package attacksuite

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

// MinCases is the floor from FR-JUDGE-10.
const MinCases = 25

// Defaults for a case that sets no limits.
var DefaultLimits = contracts.Limits{TimeMS: 1000, MemMB: 256, OutputKB: 64}

// HostChecks are the names a case may list under expect.host. The runner
// implements each; naming an unknown one is a load error.
var HostChecks = map[string]bool{
	"no-leftover-procs": true, // no process survives as a box uid after release
	"worker-alive":      true, // the runner and its parent are still running
	"env-clean":         true, // the runner's secret canary env var never appears in output
}

var slugRe = regexp.MustCompile(`^[0-9a-z]+(-[0-9a-z]+)*$`)

// Mode is how a case is executed.
type Mode string

const (
	// ModeRun runs the program once on Input and inspects its output
	// (judge.Engine.RunCustom). This is the usual containment probe.
	ModeRun Mode = "run"
	// ModeSubmit judges the program against a trivial built-in test
	// (judge.Engine.Run), for probes that must still produce a verdict.
	ModeSubmit Mode = "submit"
)

// Expect states how a contained run must look.
type Expect struct {
	Verdicts    []contracts.Verdict `yaml:"verdicts"`
	OutputLacks []string            `yaml:"outputLacks"`
	OutputHas   []string            `yaml:"outputHas"`
	Host        []string            `yaml:"host"`
}

type caseFile struct {
	Title    string             `yaml:"title"`
	Language contracts.Language `yaml:"language"`
	Mode     Mode               `yaml:"mode"`
	Input    string             `yaml:"input"`
	Expect   Expect             `yaml:"expect"`
	Limits   *struct {
		TimeMS   int64 `yaml:"timeMs"`
		MemMB    int64 `yaml:"memMb"`
		OutputKB int64 `yaml:"outputKb"`
	} `yaml:"limits"`
}

// Case is a loaded, valid attack case.
type Case struct {
	Dir        string
	Slug       string
	Title      string
	Language   contracts.Language
	SourceFile string // absolute path to the program
	Mode       Mode
	Input      string
	Limits     contracts.Limits
	Expect     Expect
}

var extLang = map[string]contracts.Language{
	".c": contracts.LanguageC, ".cpp": contracts.LanguageCpp17, ".cc": contracts.LanguageCpp17,
	".py": contracts.LanguagePython3, ".java": contracts.LanguageJava21, ".js": contracts.LanguageNode,
}

var langExt = map[contracts.Language]string{
	contracts.LanguageC: ".c", contracts.LanguageCpp17: ".cpp", contracts.LanguageCpp20: ".cpp",
	contracts.LanguagePython3: ".py", contracts.LanguageJava21: ".java", contracts.LanguageNode: ".js",
}

func validLang(l contracts.Language) bool {
	switch l {
	case contracts.LanguageC, contracts.LanguageCpp17, contracts.LanguageCpp20,
		contracts.LanguagePython3, contracts.LanguageJava21, contracts.LanguageNode:
		return true
	}
	return false
}

// Load reads one case directory (case.yaml + the program file).
func Load(dir string) (*Case, error) {
	dir = filepath.Clean(dir)
	slug := filepath.Base(dir)
	if !slugRe.MatchString(slug) {
		return nil, fmt.Errorf("attacksuite: %q is not a slug", slug)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "case.yaml"))
	if err != nil {
		return nil, fmt.Errorf("attacksuite: %s: %w", slug, err)
	}
	var cf caseFile
	d := yaml.NewDecoder(bytes.NewReader(raw))
	d.KnownFields(true)
	if err := d.Decode(&cf); err != nil {
		return nil, fmt.Errorf("attacksuite: %s/case.yaml: %w", slug, err)
	}

	c := &Case{Dir: dir, Slug: slug, Title: strings.TrimSpace(cf.Title), Language: cf.Language,
		Mode: cf.Mode, Input: cf.Input, Expect: cf.Expect, Limits: DefaultLimits}
	if cf.Limits != nil {
		c.Limits = contracts.Limits{TimeMS: cf.Limits.TimeMS, MemMB: cf.Limits.MemMB, OutputKB: cf.Limits.OutputKB}
	}
	if c.Mode == "" {
		c.Mode = ModeRun
	}

	var errs []error
	if c.Title == "" {
		errs = append(errs, errors.New("title is required"))
	}
	if c.Mode != ModeRun && c.Mode != ModeSubmit {
		errs = append(errs, fmt.Errorf("mode %q is not run or submit", c.Mode))
	}
	src, serr := findSource(dir, c.Language)
	if serr != nil {
		errs = append(errs, serr)
	} else {
		c.SourceFile = src
		if c.Language == "" {
			c.Language, _ = extLang[strings.ToLower(filepath.Ext(src))]
		}
	}
	if c.Language != "" && !validLang(c.Language) {
		errs = append(errs, fmt.Errorf("unknown language %q", c.Language))
	}
	if len(c.Expect.Verdicts) == 0 {
		errs = append(errs, errors.New("expect.verdicts must list at least one allowed verdict"))
	}
	for _, v := range c.Expect.Verdicts {
		if !validVerdict(v) {
			errs = append(errs, fmt.Errorf("expect.verdicts has unknown verdict %q", v))
		}
	}
	for _, h := range c.Expect.Host {
		if !HostChecks[h] {
			errs = append(errs, fmt.Errorf("expect.host names unknown check %q", h))
		}
	}
	if c.Limits.TimeMS < 1 || c.Limits.MemMB < 1 || c.Limits.OutputKB < 1 {
		errs = append(errs, fmt.Errorf("limits must be positive, got %+v", c.Limits))
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("attacksuite: %s: %w", slug, errors.Join(errs...))
	}
	return c, nil
}

// findSource locates the single main.<ext> program in dir. The extension must
// match the declared language, or, when none is declared, pick the language.
func findSource(dir string, lang contracts.Language) (string, error) {
	if lang != "" {
		ext, ok := langExt[lang]
		if !ok {
			return "", fmt.Errorf("unknown language %q", lang)
		}
		p := filepath.Join(dir, "main"+ext)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
			return p, nil
		}
		// cpp may be .cpp or .cc; try the other spelling
		if lang == contracts.LanguageCpp17 || lang == contracts.LanguageCpp20 {
			if p := filepath.Join(dir, "main.cc"); fileExists(p) {
				return p, nil
			}
		}
		return "", fmt.Errorf("no main%s for language %s", ext, lang)
	}
	var found []string
	for ext := range extLang {
		if p := filepath.Join(dir, "main"+ext); fileExists(p) {
			found = append(found, p)
		}
	}
	switch len(found) {
	case 0:
		return "", errors.New("no main.<ext> program and no language declared")
	case 1:
		return found[0], nil
	default:
		return "", errors.New("several main.<ext> programs; declare language")
	}
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

func validVerdict(v contracts.Verdict) bool {
	switch v {
	case contracts.VerdictAC, contracts.VerdictWA, contracts.VerdictTLE, contracts.VerdictMLE,
		contracts.VerdictRE, contracts.VerdictOLE, contracts.VerdictCE, contracts.VerdictSE:
		return true
	}
	return false
}

// Outcome is what the runner observed for a case.
type Outcome struct {
	Verdict      contracts.Verdict
	Output       string   // stdout and stderr, concatenated, for string checks
	HostFailures []string // names of host checks that failed (computed by the runner)
	RunError     string   // non-empty if the case could not be run at all
}

// Match returns the reasons a case failed, empty if it passed. The runner
// supplies the Outcome; Match holds no I/O so it is fully unit-testable.
func (c *Case) Match(o Outcome) []string {
	var fail []string
	if o.RunError != "" {
		return []string{"could not run: " + o.RunError}
	}
	if !verdictIn(o.Verdict, c.Expect.Verdicts) {
		fail = append(fail, fmt.Sprintf("verdict %s is not one of %v", o.Verdict, c.Expect.Verdicts))
	}
	for _, s := range c.Expect.OutputLacks {
		if strings.Contains(o.Output, s) {
			fail = append(fail, fmt.Sprintf("output must not contain %q (a blocked action may have succeeded)", s))
		}
	}
	for _, s := range c.Expect.OutputHas {
		if !strings.Contains(o.Output, s) {
			fail = append(fail, fmt.Sprintf("output must contain %q", s))
		}
	}
	for _, h := range o.HostFailures {
		fail = append(fail, "host check failed: "+h)
	}
	return fail
}

func verdictIn(v contracts.Verdict, set []contracts.Verdict) bool {
	for _, x := range set {
		if x == v {
			return true
		}
	}
	return false
}

// LoadAll loads every case directory under root/cases (a dir is a case when it
// holds a case.yaml). If root has no cases/ subdirectory, root itself is
// scanned for case directories, so a group like selftest/ works too.
func LoadAll(root string) ([]*Case, error) {
	casesDir := filepath.Join(root, "cases")
	if fi, err := os.Stat(casesDir); err != nil || !fi.IsDir() {
		casesDir = root
	}
	entries, err := os.ReadDir(casesDir)
	if err != nil {
		return nil, err
	}
	var cases []*Case
	var errs []error
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(casesDir, e.Name(), "case.yaml")); err != nil {
			continue
		}
		c, err := Load(filepath.Join(casesDir, e.Name()))
		if err != nil {
			errs = append(errs, err)
			continue
		}
		cases = append(cases, c)
	}
	return cases, errors.Join(errs...)
}
