package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"
	"sync"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/testcache"
)

// Executor judges one job. Errors mean "the job could not be judged"
// (infrastructure or a broken job); a verdict, even SE for a jury error, is
// returned in the Outcome.
type Executor interface {
	Execute(ctx context.Context, job contracts.JudgeJob, progress judge.Progress) (*judge.Outcome, error)
}

// ErrUnsupported marks jobs this worker cannot judge yet.
var ErrUnsupported = errors.New("worker: unsupported job")

// permanent errors will fail the same way on every attempt, so they are not
// retried. Everything else (sandbox, Redis, object store hiccups) is.
func permanent(err error) bool {
	for _, target := range []error{
		ErrInvalidJob, ErrUnsupported, judge.ErrUnknownLanguage,
		testcache.ErrBadURI, testcache.ErrBadHash, testcache.ErrHashMismatch,
		testcache.ErrBadTestset, testcache.ErrNotFound, testcache.ErrTooLarge,
	} {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}

const (
	checkerPrefix   = "checkers/"
	maxCheckerBytes = 256 << 10
	maxCheckerCache = 64
)

// Runner is the production Executor: slot pool + testset cache + engine.
type Runner struct {
	Pool   *sandbox.Pool
	Cache  *testcache.Cache
	Store  testcache.Store
	Bucket string
	Engine *judge.Engine

	mu       sync.Mutex
	checkers map[string][]byte // compiled testlib checkers by problem version + URI
	order    []string
}

// Execute implements Executor.
func (r *Runner) Execute(ctx context.Context, job contracts.JudgeJob, progress judge.Progress) (*judge.Outcome, error) {
	if job.Mode == contracts.JobModeRun && job.CustomInput != nil {
		// Custom runs need the program's output sent back, and TestOutcome has
		// no field for it yet (follow-up: contracts + interactive lane).
		return nil, fmt.Errorf("%w: custom input runs", ErrUnsupported)
	}
	ts, err := r.Cache.Get(ctx, job.Problem.TestsetHash, job.Problem.TestsetURI)
	if err != nil {
		return nil, err
	}
	defer ts.Release()
	tests := make([]judge.Test, 0, len(ts.Cases))
	for _, c := range ts.Cases {
		in, ans, err := ts.Load(c.No)
		if err != nil {
			return nil, err
		}
		tests = append(tests, judge.Test{No: c.No, In: in, Ans: ans})
	}

	slot, err := r.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = r.Pool.Release(context.WithoutCancel(ctx), slot) }()

	req := judge.Request{
		Language:           job.Language,
		Source:             job.Source,
		Limits:             job.Problem.Limits,
		Checker:            job.Problem.Checker,
		StopOnFirstFailure: job.StopOnFirstFailure,
		Tests:              tests,
	}
	if job.Problem.Checker.Kind == contracts.CheckerKindTestlib {
		bin, err := r.checkerBinary(ctx, slot, job.Problem)
		switch {
		case errors.Is(err, judge.ErrCheckerCompile):
			// A checker that does not build is a broken problem: SE + alert.
			return &judge.Outcome{Verdict: contracts.VerdictSE, JuryError: err.Error()}, nil
		case err != nil:
			return nil, err
		}
		req.CheckerBinary = bin
	}
	return r.Engine.Run(ctx, slot, req, progress)
}

// checkerBinary returns the compiled testlib checker for a problem version,
// compiling it once per worker. The object named by checker.binaryUri holds
// the checker's C++ source: custom checkers are compiled on each judge
// (SD-§8.5), never trusted as prebuilt binaries.
func (r *Runner) checkerBinary(ctx context.Context, slot *sandbox.Slot, p contracts.ProblemRef) ([]byte, error) {
	key := p.VersionID + "|" + *p.Checker.BinaryURI
	r.mu.Lock()
	bin, ok := r.checkers[key]
	r.mu.Unlock()
	if ok {
		return bin, nil
	}
	src, err := r.fetchObject(ctx, *p.Checker.BinaryURI, checkerPrefix, maxCheckerBytes)
	if err != nil {
		return nil, err
	}
	bin, err = judge.CompileChecker(ctx, r.Engine.Reg, slot.Compile, string(src))
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.checkers == nil {
		r.checkers = map[string][]byte{}
	}
	r.checkers[key] = bin
	r.order = append(r.order, key)
	if len(r.order) > maxCheckerCache {
		delete(r.checkers, r.order[0])
		r.order = r.order[1:]
	}
	return bin, nil
}

// fetchObject reads a small object, applying the same rules as testset URIs:
// the configured bucket only, a fixed key prefix, no tricks, a size cap.
func (r *Runner) fetchObject(ctx context.Context, uri, prefix string, limit int64) ([]byte, error) {
	u, err := url.Parse(uri)
	key := strings.TrimPrefix(u.Path, "/")
	if err != nil || u.Scheme != "s3" || u.Host != r.Bucket || u.RawQuery != "" || u.Fragment != "" ||
		path.Clean(key) != key || !strings.HasPrefix(key, prefix) {
		return nil, fmt.Errorf("%w: %q", testcache.ErrBadURI, uri)
	}
	body, size, err := r.Store.Open(ctx, u.Host, key)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	if size > limit {
		return nil, fmt.Errorf("%w: %s is %d bytes", testcache.ErrTooLarge, key, size)
	}
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, testcache.ErrTooLarge
	}
	return data, nil
}
