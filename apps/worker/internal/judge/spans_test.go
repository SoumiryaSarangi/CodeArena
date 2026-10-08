package judge

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

// NFR-OBS-01 / SD-§15.1: a run draws judge.compile, one judge.test per test and a judge.checker
// per checked test under the job's span, all in one trace. Needs isolate.
func TestPhaseSpans(t *testing.T) {
	e := setup(t)
	rec := tracetest.NewSpanRecorder()
	tp := trace.NewTracerProvider(trace.WithSpanProcessor(rec))
	ctx, job := tp.Tracer("t").Start(context.Background(), "judge.job")

	slot, err := e.pool.Acquire(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = e.pool.Release(e.ctx, slot) }()
	req := Request{Language: "c", Source: programs["c"]["AC"], Limits: limits,
		Checker: contracts.Checker{Kind: contracts.CheckerKindTokens},
		Tests: []Test{
			{No: 1, In: []byte("1 2\n"), Ans: []byte("3\n")},
			{No: 2, In: []byte("5 5\n"), Ans: []byte("10\n")},
		}}
	if _, err := e.eng.Run(ctx, slot, req, nil); err != nil {
		t.Fatal(err)
	}
	job.End()

	count := map[string]int{}
	for _, s := range rec.Ended() {
		count[s.Name()]++
		if s.SpanContext().TraceID() != job.SpanContext().TraceID() {
			t.Errorf("%s is in another trace", s.Name())
		}
	}
	if count["judge.compile"] != 1 || count["judge.test"] != 2 || count["judge.checker"] != 2 {
		t.Fatalf("spans: %v", count)
	}
	// Each checker span sits inside its test span; tests and compile hang off the job.
	byID := map[string]string{}
	for _, s := range rec.Ended() {
		byID[s.SpanContext().SpanID().String()] = s.Name()
	}
	for _, s := range rec.Ended() {
		parent := byID[s.Parent().SpanID().String()]
		switch s.Name() {
		case "judge.checker":
			if parent != "judge.test" {
				t.Errorf("checker parent is %q", parent)
			}
		case "judge.compile", "judge.test":
			if s.Parent().SpanID() != job.SpanContext().SpanID() {
				t.Errorf("%s is not a child of the job", s.Name())
			}
		}
	}
}

// A compile error ends the run before any test span exists.
func TestCompileErrorHasNoTestSpans(t *testing.T) {
	e := setup(t)
	rec := tracetest.NewSpanRecorder()
	tp := trace.NewTracerProvider(trace.WithSpanProcessor(rec))
	ctx, job := tp.Tracer("t").Start(context.Background(), "judge.job")
	slot, err := e.pool.Acquire(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = e.pool.Release(e.ctx, slot) }()
	req := Request{Language: "c", Source: "this is not C", Limits: limits,
		Checker: contracts.Checker{Kind: contracts.CheckerKindTokens},
		Tests:   []Test{{No: 1, In: []byte("1\n"), Ans: []byte("1\n")}}}
	out, err := e.eng.Run(ctx, slot, req, nil)
	if err != nil || out.Verdict != contracts.VerdictCE {
		t.Fatalf("%v %+v", err, out)
	}
	job.End()
	for _, s := range rec.Ended() {
		if s.Name() == "judge.test" || s.Name() == "judge.checker" {
			t.Fatalf("unexpected span %s", s.Name())
		}
	}
}
