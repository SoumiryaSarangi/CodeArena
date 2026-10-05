package judge

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/languages"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

// Test is one ordered test case, supplied by the test cache (J-04).
type Test struct {
	No  int
	In  []byte
	Ans []byte
}

// Request is everything the pipeline needs to judge one submission.
type Request struct {
	Language contracts.Language
	Source   string
	Limits   contracts.Limits
	Checker  contracts.Checker
	// CheckerBinary is the compiled testlib checker (CompileChecker); only
	// used when Checker.Kind is testlib.
	CheckerBinary []byte
	// StopOnFirstFailure ends judging at the first test that is not AC
	// (always the case in contest lanes, FR-JUDGE-07).
	StopOnFirstFailure bool
	Tests              []Test
}

// Outcome is the pipeline's result before the worker adds IDs and times.
type Outcome struct {
	Verdict    contracts.Verdict
	CompileLog string // set for CE
	Tests      []contracts.TestOutcome
	TimeMS     int64 // max over tests
	MemKB      int64 // max over tests
	// JuryError is set when a checker failed (verdict SE): the worker must
	// raise an alert, the problem is broken, not the submission.
	JuryError string
}

// Engine judges submissions with a language registry.
type Engine struct {
	Reg *languages.Registry
}

// Progress is called when judging enters a phase and after each test.
type Progress func(phase contracts.JudgePhase, test *contracts.TestOutcome)

// ErrUnknownLanguage is returned for a language not in the registry.
var ErrUnknownLanguage = errors.New("judge: unknown language")

const (
	// stderrPeek is how much of a failed program's stderr is scanned for
	// out-of-memory markers.
	stderrPeek = 4096
	// outputSlack mirrors the extra KB the run spec gives the sandbox file
	// size limit; reading that much is enough to see "over the limit".
	outputSlack = 1024
)

// Run executes SD-§8.1 on a slot: compile, then each test in a fresh run box,
// map the run to a verdict, check the output, and stop early when asked.
// A returned error means the sandbox failed (SE: the worker retries, then
// dead-letters); a failing checker is an SE *verdict* with JuryError set.
func (e *Engine) Run(ctx context.Context, slot *sandbox.Slot, req Request, progress Progress) (*Outcome, error) {
	if progress == nil {
		progress = func(contracts.JudgePhase, *contracts.TestOutcome) {}
	}
	l, ok := e.Reg.Get(req.Language)
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownLanguage, req.Language)
	}
	if len(req.Tests) == 0 {
		return nil, errors.New("judge: no tests")
	}

	progress(contracts.JudgePhaseCompiling, nil)
	comp, err := e.Reg.Compile(ctx, slot.Compile, l, req.Source)
	switch {
	case errors.Is(err, languages.ErrSourceTooLarge):
		return &Outcome{Verdict: contracts.VerdictCE, CompileLog: fmt.Sprintf("source is larger than %d KB", languages.MaxSourceBytes>>10)}, nil
	case err != nil:
		return nil, err
	case !comp.OK:
		return &Outcome{Verdict: contracts.VerdictCE, CompileLog: comp.Log}, nil
	}

	progress(contracts.JudgePhaseRunning, nil)
	out := &Outcome{Verdict: contracts.VerdictAC}
	for _, t := range req.Tests {
		to, jury, err := e.runTest(ctx, slot, l, comp.Artifacts, req, t)
		if err != nil {
			return nil, err
		}
		out.Tests = append(out.Tests, to)
		out.TimeMS = max(out.TimeMS, to.TimeMS)
		out.MemKB = max(out.MemKB, to.MemKB)
		if to.Verdict != contracts.VerdictAC && out.Verdict == contracts.VerdictAC {
			out.Verdict = to.Verdict
		}
		progress(contracts.JudgePhaseRunning, &to)
		if jury != "" {
			out.JuryError = jury
			break // a broken problem: further tests prove nothing
		}
		if to.Verdict != contracts.VerdictAC && req.StopOnFirstFailure {
			break
		}
	}
	return out, nil
}

// runTest re-initialises the run box so no file, process or state from an
// earlier test (or from the compiler) survives, then runs one test.
func (e *Engine) runTest(ctx context.Context, slot *sandbox.Slot, l *languages.Language, arts []languages.Artifact, req Request, t Test) (to contracts.TestOutcome, jury string, err error) {
	to = contracts.TestOutcome{No: int64(t.No)}
	if err = languages.Install(ctx, slot.Run, arts); err != nil {
		return to, "", err
	}
	if err = slot.Run.WriteFile("in.txt", t.In, 0o644); err != nil {
		return to, "", err
	}
	meta, err := slot.Run.Run(ctx, l.RunSpec(req.Limits, "in.txt", "out.txt", "err.txt"))
	if err != nil {
		return to, "", err
	}
	to.TimeMS, to.MemKB = meta.TimeMS, meta.CgMemKB

	limit := req.Limits.OutputKB * 1024
	output, _, rerr := slot.Run.ReadFile("out.txt", limit+outputSlack)
	info := RunInfo{Meta: meta, OutputBytes: int64(len(output)), OutputLimit: limit, OOMMarkers: l.OOMMarkers}
	if meta.Status == sandbox.StatusRE || meta.Status == sandbox.StatusSG {
		if data, _, err := slot.Run.ReadFile("err.txt", stderrPeek); err == nil {
			info.Stderr = string(data)
		}
	}
	v, sig, clean := MapRun(info)
	if !clean {
		to.Verdict = v
		if sig != "" {
			to.Signal = &sig
		}
		return to, "", nil
	}
	if rerr != nil {
		// The program exited 0 but its output file is gone or was swapped for a
		// link or FIFO: it tampered with the box. Nothing was followed.
		to.Verdict = contracts.VerdictWA
		to.CheckerMsg = ptr("output file is missing or not a regular file")
		return to, "", nil
	}

	var res CheckResult
	if req.Checker.Kind == contracts.CheckerKindTestlib {
		if len(req.CheckerBinary) == 0 {
			res = CheckResult{Status: CheckFail, Msg: "testlib checker binary missing"}
		} else if res, err = RunTestlib(ctx, slot.Checker, req.CheckerBinary, t.In, output, t.Ans); err != nil {
			return to, "", err
		}
	} else {
		res = Check(req.Checker, output, t.Ans)
	}
	to.Verdict = MapChecker(res)
	if res.Msg != "" && to.Verdict != contracts.VerdictAC {
		to.CheckerMsg = ptr(res.Msg)
	}
	if to.Verdict == contracts.VerdictSE {
		jury = strings.TrimSpace(res.Msg)
		if jury == "" {
			jury = "checker failed"
		}
	}
	return to, jury, nil
}

func ptr[T any](v T) *T { return &v }
