// Command attack runs the sandbox-containment suite (J-07, FR-JUDGE-10): each
// case in tests/attack-suite/cases is compiled and run in an isolate box, and
// its outcome is matched against the case's expectations, including host-side
// checks that run outside the box. It prints a table and exits non-zero if any
// case fails or there are fewer than the required number of cases.
//
//	attack [-j N] [-v] <attack-suite dir | single case dir>
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/attacksuite"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/languages"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

func main() {
	jobs := flag.Int("j", 2, "cases run in parallel (one core each)")
	verbose := flag.Bool("v", false, "show output excerpts for failing cases")
	minCases := flag.Int("min", attacksuite.MinCases, "fail if fewer than this many cases exist (FR-JUDGE-10)")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: attack [-j N] [-v] <attack-suite dir | single case dir>")
		os.Exit(2)
	}
	os.Exit(run(flag.Arg(0), *jobs, *verbose, *minCases))
}

func run(target string, jobs int, verbose bool, minCases int) int {
	cases, err := load(target)
	if err != nil {
		fmt.Fprintln(os.Stderr, "attack:", err)
		return 2
	}
	if len(cases) == 0 {
		fmt.Fprintln(os.Stderr, "attack: no cases found (expected case directories with a case.yaml)")
		return 1
	}

	reg, err := languages.Default()
	if err != nil {
		fatal(err)
	}
	if jobs < 1 {
		jobs = 1
	}
	cores := make([]int, jobs)
	for i := range cores {
		cores[i] = i
	}
	ctx := context.Background()
	// Box ids 870+ keep clear of validate-problem (800+/850+) and the worker.
	pool, err := sandbox.New(ctx, sandbox.Config{Cores: cores, BoxIDBase: 870})
	if err != nil {
		fmt.Fprintf(os.Stderr, "attack: sandbox unavailable: %v\n", err)
		fmt.Fprintln(os.Stderr, "        (isolate must be installed: sudo scripts/setup-isolate-wsl.sh)")
		return 2
	}
	defer func() { _ = pool.Close(ctx) }()

	r := &runner{reg: reg, eng: &judge.Engine{Reg: reg}, pool: pool, uidBase: readUIDBase()}
	// A secret the env-clean check looks for; set in our own environment so a
	// program that dumps its environment or the host's cannot contain it.
	r.canary = "CA-" + randHex()
	os.Setenv("CODEARENA_ATTACK_CANARY", r.canary)

	results := make([]result, len(cases))
	sem := make(chan struct{}, jobs)
	var wg sync.WaitGroup
	for i, c := range cases {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = r.runCase(ctx, c)
		}()
	}
	wg.Wait()

	failed := report(results, verbose)
	if len(cases) < minCases {
		fmt.Printf("\nonly %d case(s); FR-JUDGE-10 needs at least %d\n", len(cases), minCases)
		failed++
	}
	if failed > 0 {
		return 1
	}
	return 0
}

// load accepts either the suite root (with a cases/ dir) or a single case dir.
func load(target string) ([]*attacksuite.Case, error) {
	if _, err := os.Stat(filepath.Join(target, "case.yaml")); err == nil {
		c, err := attacksuite.Load(target)
		if err != nil {
			return nil, err
		}
		return []*attacksuite.Case{c}, nil
	}
	cases, err := attacksuite.LoadAll(target)
	if err != nil {
		return nil, err
	}
	sort.Slice(cases, func(i, j int) bool { return cases[i].Slug < cases[j].Slug })
	return cases, nil
}

func fatal(err error) { fmt.Fprintln(os.Stderr, "attack:", err); os.Exit(2) }

type runner struct {
	reg     *languages.Registry
	eng     *judge.Engine
	pool    *sandbox.Pool
	canary  string
	uidBase int
}

type result struct {
	c       *attacksuite.Case
	outcome attacksuite.Outcome
	fail    []string
	took    time.Duration
}

func (r *runner) runCase(ctx context.Context, c *attacksuite.Case) result {
	start := time.Now()
	res := result{c: c}
	src, err := os.ReadFile(c.SourceFile)
	if err != nil {
		res.outcome.RunError = err.Error()
		res.fail = c.Match(res.outcome)
		return res
	}
	slot, err := r.pool.Acquire(ctx)
	if err != nil {
		res.outcome.RunError = err.Error()
		res.fail = c.Match(res.outcome)
		return res
	}
	// boxUIDs are the uids this slot's boxes run as; checked for leftovers
	// after Release.
	boxUIDs := []int{r.uidBase + slot.Compile.ID, r.uidBase + slot.Run.ID, r.uidBase + slot.Checker.ID}

	var out *judge.Outcome
	if c.Mode == attacksuite.ModeSubmit {
		out, err = r.eng.Run(ctx, slot, judge.Request{
			Language: c.Language, Source: string(src), Limits: c.Limits,
			Checker: contracts.Checker{Kind: contracts.CheckerKindTokens}, StopOnFirstFailure: true,
			Tests: []judge.Test{{No: 1, In: []byte(c.Input), Ans: []byte("")}},
		}, nil)
	} else {
		out, err = r.eng.RunCustom(ctx, slot, judge.CustomRequest{
			Language: c.Language, Source: string(src), Limits: c.Limits, Input: []byte(c.Input),
		}, nil)
	}
	_ = r.pool.Release(ctx, slot)

	if err != nil {
		res.outcome.RunError = err.Error()
		res.fail = c.Match(res.outcome)
		res.took = time.Since(start)
		return res
	}
	res.outcome.Verdict = out.Verdict
	res.outcome.Output = combined(out)
	res.outcome.HostFailures = r.hostChecks(c.Expect.Host, res.outcome.Output, boxUIDs)
	res.fail = c.Match(res.outcome)
	res.took = time.Since(start)
	return res
}

func combined(o *judge.Outcome) string {
	var b strings.Builder
	if o.Output != nil {
		b.WriteString(*o.Output)
	}
	if o.Stderr != nil {
		b.WriteString("\n")
		b.WriteString(*o.Stderr)
	}
	b.WriteString("\n")
	b.WriteString(o.CompileLog)
	return b.String()
}

// hostChecks runs the named checks and returns those that failed.
func (r *runner) hostChecks(names []string, output string, boxUIDs []int) []string {
	var failed []string
	for _, name := range names {
		ok := true
		switch name {
		case "no-leftover-procs":
			ok = noProcsForUIDs(boxUIDs)
		case "worker-alive":
			ok = os.Getpid() > 0 && parentAlive()
		case "env-clean":
			ok = !strings.Contains(output, r.canary)
		}
		if !ok {
			failed = append(failed, name)
		}
	}
	return failed
}

func report(results []result, verbose bool) int {
	failed := 0
	fmt.Printf("%-26s %-8s %-5s %-18s %s\n", "case", "lang", "verd", "allowed", "result")
	fmt.Println(strings.Repeat("-", 78))
	for _, r := range results {
		status := "PASS"
		if len(r.fail) > 0 {
			status = "FAIL"
			failed++
		}
		fmt.Printf("%-26s %-8s %-5s %-18s %s  %5dms\n", trunc(r.c.Slug, 26), r.c.Language,
			r.outcome.Verdict, verdicts(r.c.Expect.Verdicts), status, r.took.Milliseconds())
		if len(r.fail) > 0 {
			for _, f := range r.fail {
				fmt.Printf("        - %s\n", f)
			}
			if verbose && r.outcome.Output != "" {
				fmt.Printf("        output: %s\n", trunc(strings.ReplaceAll(strings.TrimSpace(r.outcome.Output), "\n", " "), 200))
			}
		}
	}
	fmt.Printf("\n%d case(s), %d failed\n", len(results), failed)
	return failed
}

func verdicts(vs []contracts.Verdict) string {
	s := make([]string, len(vs))
	for i, v := range vs {
		s[i] = string(v)
	}
	return strings.Join(s, "/")
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n-1] + "…"
	}
	return s
}

// readUIDBase reads first_uid from isolate's config so no-leftover-procs knows
// which uids a box runs as. Defaults to 60000 (our setup script's value).
func readUIDBase() int {
	for _, p := range []string{"/usr/local/etc/isolate", "/etc/isolate"} {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "first_uid") {
				if _, v, ok := strings.Cut(line, "="); ok {
					if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
						return n
					}
				}
			}
		}
	}
	return 60000
}
