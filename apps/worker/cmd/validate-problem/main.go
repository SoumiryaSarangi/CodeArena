// Command validate-problem checks problem packages: structure (SRS §3.1.6),
// every test input against the testlib validator, and every declared solution
// against its expected verdict, all through the real judge engine in isolate
// boxes. It exits non-zero if anything is wrong.
//
//	validate-problem [-j N] [-v] <package dir | directory of packages>...
//	validate-problem -tar out.tar <package dir>   # write the testset archive, print its hash
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/languages"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/problempkg"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

func main() {
	jobs := flag.Int("j", 2, "solutions judged in parallel (one core each)")
	verbose := flag.Bool("v", false, "list per-test outcomes of mismatching solutions")
	tarOut := flag.String("tar", "", "write the testset archive of the single package given and print its SHA-256")
	flag.Parse()
	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: validate-problem [-j N] [-v] <package dir | directory of packages>...")
		os.Exit(2)
	}
	dirs, err := expand(flag.Args())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *tarOut != "" {
		os.Exit(writeTar(dirs, *tarOut))
	}
	ctx := context.Background()
	reg, err := languages.Default()
	if err != nil {
		fatal(err)
	}
	cores := make([]int, *jobs)
	for i := range cores {
		cores[i] = i
	}
	// Box ids 800+ stay clear of a dev worker (100+) and of the package tests.
	pool, err := sandbox.New(ctx, sandbox.Config{Cores: cores, BoxIDBase: 800})
	if err != nil {
		fatal(fmt.Errorf("sandbox: %w (is isolate installed? see scripts/setup-isolate-wsl.sh)", err))
	}
	defer func() { _ = pool.Close(ctx) }()
	v := &validator{pool: pool, reg: reg, eng: &judge.Engine{Reg: reg}, verbose: *verbose}

	failed := 0
	start := time.Now()
	for _, d := range dirs {
		if !v.validate(ctx, d) {
			failed++
		}
	}
	fmt.Printf("\n%d package(s), %d failed, %s\n", len(dirs), failed, time.Since(start).Round(time.Second))
	if failed > 0 {
		os.Exit(1)
	}
}

func fatal(err error) { fmt.Fprintln(os.Stderr, "validate-problem:", err); os.Exit(2) }

// expand turns arguments into package directories: a directory with a
// problem.yaml is a package, any other directory is searched one level down.
func expand(args []string) ([]string, error) {
	var dirs []string
	for _, a := range args {
		if _, err := os.Stat(filepath.Join(a, "problem.yaml")); err == nil {
			dirs = append(dirs, a)
			continue
		}
		entries, err := os.ReadDir(a)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if e.IsDir() && !strings.HasPrefix(e.Name(), "_") && !strings.HasPrefix(e.Name(), ".") {
				if _, err := os.Stat(filepath.Join(a, e.Name(), "problem.yaml")); err == nil {
					dirs = append(dirs, filepath.Join(a, e.Name()))
				}
			}
		}
	}
	if len(dirs) == 0 {
		return nil, errors.New("no problem packages found")
	}
	sort.Strings(dirs)
	return dirs, nil
}

func writeTar(dirs []string, out string) int {
	if len(dirs) != 1 {
		fmt.Fprintln(os.Stderr, "-tar needs exactly one package")
		return 2
	}
	p, err := problempkg.Load(dirs[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	data, hash, err := p.Tar()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := os.WriteFile(out, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(hash)
	return 0
}

type validator struct {
	pool    *sandbox.Pool
	reg     *languages.Registry
	eng     *judge.Engine
	verbose bool
}

func (v *validator) validate(ctx context.Context, dir string) bool {
	p, err := problempkg.Load(dir)
	if err != nil {
		fmt.Printf("FAIL  %s\n", filepath.Base(dir))
		for _, line := range strings.Split(err.Error(), "\n") {
			fmt.Printf("        - %s\n", line)
		}
		return false
	}
	var problems []string
	problems = append(problems, v.checkValidator(ctx, p)...)

	req := judge.Request{Limits: p.Limits(), Checker: p.Checker(), StopOnFirstFailure: true}
	for _, t := range p.Tests {
		req.Tests = append(req.Tests, judge.Test{No: t.No, In: t.In, Ans: t.Ans})
	}
	if p.Meta.Checker.Kind == contracts.CheckerKindTestlib {
		src, _ := p.Read("checker.cpp")
		bin, err := v.compile(ctx, src)
		if err != nil {
			problems = append(problems, "checker.cpp: "+err.Error())
		}
		req.CheckerBinary = bin
	}

	type row struct {
		sol  problempkg.Solution
		out  *judge.Outcome
		err  error
		took time.Duration
	}
	rows := make([]row, len(p.Meta.Solutions))
	var wg sync.WaitGroup
	if len(problems) == 0 {
		for i, s := range p.Meta.Solutions {
			wg.Add(1)
			go func() {
				defer wg.Done()
				rows[i].sol = s
				src, err := p.Read(filepath.Join("solutions", s.File))
				lang, _ := problempkg.LanguageOf(s.File)
				if err != nil {
					rows[i].err = err
					return
				}
				r := req
				r.Language, r.Source = lang, src
				slot, err := v.pool.Acquire(ctx)
				if err != nil {
					rows[i].err = err
					return
				}
				defer func() { _ = v.pool.Release(ctx, slot) }()
				t0 := time.Now()
				rows[i].out, rows[i].err = v.eng.Run(ctx, slot, r, nil)
				rows[i].took = time.Since(t0)
			}()
		}
		wg.Wait()
	}

	var lines []string
	for _, r := range rows {
		switch {
		case r.sol.File == "":
		case r.err != nil:
			problems = append(problems, fmt.Sprintf("solutions/%s: could not be judged: %v", r.sol.File, r.err))
		case r.out.Verdict != r.sol.Expected:
			msg := fmt.Sprintf("solutions/%s: expected %s, got %s", r.sol.File, r.sol.Expected, r.out.Verdict)
			if r.out.Verdict == contracts.VerdictCE {
				msg += "\n" + indent(r.out.CompileLog)
			}
			if v.verbose || r.out.Verdict == contracts.VerdictSE {
				msg += "\n" + describe(r.out)
			}
			problems = append(problems, msg)
		default:
			lines = append(lines, fmt.Sprintf("%-22s %-3s  %4d tests  %5d ms  %6.1f MB", r.sol.File, r.out.Verdict, len(r.out.Tests), r.out.TimeMS, float64(r.out.MemKB)/1024))
		}
	}
	if len(problems) > 0 {
		fmt.Printf("FAIL  %s\n", p.Slug)
		for _, l := range lines {
			fmt.Printf("        ok  %s\n", l)
		}
		for _, pr := range problems {
			fmt.Printf("        - %s\n", strings.ReplaceAll(pr, "\n", "\n          "))
		}
		return false
	}
	fmt.Printf("ok    %-28s %2d tests, %d solutions\n", p.Slug, len(p.Tests), len(p.Meta.Solutions))
	if v.verbose {
		for _, l := range lines {
			fmt.Printf("        %s\n", l)
		}
	}
	return true
}

func (v *validator) compile(ctx context.Context, src string) ([]byte, error) {
	slot, err := v.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = v.pool.Release(ctx, slot) }()
	return judge.CompileChecker(ctx, v.reg, slot.Compile, src)
}

// checkValidator compiles validator.cpp and runs every input through it.
func (v *validator) checkValidator(ctx context.Context, p *problempkg.Package) []string {
	src, _ := p.Read("validator.cpp")
	bin, err := v.compile(ctx, src)
	if err != nil {
		return []string{"validator.cpp: " + err.Error()}
	}
	slot, err := v.pool.Acquire(ctx)
	if err != nil {
		return []string{err.Error()}
	}
	defer func() { _ = v.pool.Release(ctx, slot) }()
	var out []string
	for _, t := range p.Tests {
		ok, msg, err := judge.RunValidator(ctx, slot.Checker, bin, t.In)
		switch {
		case err != nil:
			return append(out, fmt.Sprintf("validator on tests/%02d.in: %v", t.No, err))
		case !ok:
			out = append(out, fmt.Sprintf("validator rejects tests/%02d.in: %s", t.No, msg))
		}
	}
	return out
}

func describe(o *judge.Outcome) string {
	var b strings.Builder
	for _, t := range o.Tests {
		fmt.Fprintf(&b, "test %02d: %s %d ms", t.No, t.Verdict, t.TimeMS)
		if t.CheckerMsg != nil {
			fmt.Fprintf(&b, " (%s)", *t.CheckerMsg)
		}
		b.WriteString("\n")
	}
	if o.JuryError != "" {
		b.WriteString("jury error: " + o.JuryError)
	}
	return strings.TrimRight(b.String(), "\n")
}

func indent(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 800 {
		s = s[:800] + "…"
	}
	return "    " + strings.ReplaceAll(s, "\n", "\n    ")
}
