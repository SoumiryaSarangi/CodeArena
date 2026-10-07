package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
)

// fakeExec is a scriptable Executor.
type fakeExec struct {
	calls   atomic.Int64
	started chan string   // submission ids as jobs start, if non-nil
	release chan struct{} // jobs wait on it, if non-nil
	fn      func(call int, job contracts.JudgeJob) (*judge.Outcome, error)
}

func (f *fakeExec) Execute(ctx context.Context, job contracts.JudgeJob, progress judge.Progress) (*judge.Outcome, error) {
	n := int(f.calls.Add(1))
	if f.started != nil {
		f.started <- job.SubmissionID
	}
	progress(contracts.JudgePhaseCompiling, nil)
	if f.release != nil {
		select {
		case <-f.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.fn != nil {
		return f.fn(n, job)
	}
	t := contracts.TestOutcome{No: 1, Verdict: contracts.VerdictAC, TimeMS: 5, MemKB: 100}
	progress(contracts.JudgePhaseRunning, &t)
	return &judge.Outcome{Verdict: contracts.VerdictAC, TimeMS: 5, MemKB: 100, Tests: []contracts.TestOutcome{t}}, nil
}

func quiet() *slog.Logger {
	if os.Getenv("WORKER_TEST_LOG") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func enqueue(t *testing.T, rdb *redis.Client, job contracts.JudgeJob) string {
	t.Helper()
	id, err := rdb.XAdd(context.Background(), &redis.XAddArgs{Stream: JobsKey(job.Lane), Values: map[string]any{FieldJob: encode(t, job)}}).Result()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// start runs a worker and returns a stop function that cancels and waits.
func start(t *testing.T, rdb *redis.Client, ex Executor, tweak func(*Config)) (*Worker, context.CancelFunc, <-chan error) {
	t.Helper()
	cfg := Config{Redis: rdb, Exec: ex, WorkerID: "w1", Block: 100 * time.Millisecond, HeartbeatEvery: 100 * time.Millisecond,
		RetryBackoff: 10 * time.Millisecond, Log: quiet()}
	if tweak != nil {
		tweak(&cfg)
	}
	w, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	})
	return w, cancel, done
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	waitWithin(t, 10*time.Second, what, cond)
}

// waitWithin is waitFor with a budget, for tests that compile C++ in sandbox boxes.
func waitWithin(t *testing.T, budget time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func streamLen(rdb *redis.Client, key string) int64 { return rdb.XLen(context.Background(), key).Val() }

func pending(rdb *redis.Client, stream string) int64 {
	p, err := rdb.XPending(context.Background(), stream, Group).Result()
	if err != nil {
		return 0
	}
	return p.Count
}

func results(t *testing.T, rdb *redis.Client) []contracts.JudgeResult {
	t.Helper()
	msgs, err := rdb.XRange(context.Background(), ResultsKey, "-", "+").Result()
	if err != nil {
		t.Fatal(err)
	}
	var out []contracts.JudgeResult
	for _, m := range msgs {
		var r contracts.JudgeResult
		dec := json.NewDecoder(stringsReader(m.Values[FieldResult].(string)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			t.Fatalf("result does not match the contract: %v", err)
		}
		out = append(out, r)
	}
	return out
}

func TestEndToEndProtocol(t *testing.T) {
	rdb := startRedis(t)
	ctx := context.Background()
	sub := rdb.Subscribe(ctx, ProgressChannel("sub-1"))
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	var events []contracts.JudgeProgress
	var evMu sync.Mutex
	go func() {
		for m := range sub.Channel() {
			var p contracts.JudgeProgress
			if json.Unmarshal([]byte(m.Payload), &p) == nil {
				evMu.Lock()
				events = append(events, p)
				evMu.Unlock()
			}
		}
	}()

	start(t, rdb, &fakeExec{}, nil)
	entry := enqueue(t, rdb, validJob("1"))
	waitFor(t, "a result", func() bool { return streamLen(rdb, ResultsKey) == 1 })

	t.Run("J-05 accept: a job XADDed to jobs:practice produces a JudgeResult on results", func(t *testing.T) {
		r := results(t, rdb)[0]
		if r.SubmissionID != "sub-1" || r.RunVersion != 1 || r.Verdict != contracts.VerdictAC || r.WorkerID != "w1" ||
			len(r.Tests) != 1 || r.TimeMS != 5 || r.FinishedAt == 0 {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("FR-QUEUE-01: the job is acknowledged and deleted once its result is durable", func(t *testing.T) {
		waitFor(t, "ack", func() bool { return pending(rdb, "jobs:practice") == 0 })
		if streamLen(rdb, "jobs:practice") != 0 {
			t.Fatal("the job entry was not deleted")
		}
		_ = entry
	})
	t.Run("FR-JUDGE-11: progress is published per phase and per test", func(t *testing.T) {
		waitFor(t, "progress", func() bool { evMu.Lock(); defer evMu.Unlock(); return len(events) >= 4 })
		evMu.Lock()
		defer evMu.Unlock()
		var phases []contracts.JudgePhase
		tests := 0
		for _, e := range events {
			if e.SubmissionID != "sub-1" || e.RunVersion != 1 || e.WorkerID != "w1" || e.Ts == 0 {
				t.Fatalf("%+v", e)
			}
			phases = append(phases, e.Phase)
			if e.Test != nil {
				tests++
			}
		}
		want := []contracts.JudgePhase{contracts.JudgePhaseClaimed, contracts.JudgePhaseCompiling, contracts.JudgePhaseRunning, contracts.JudgePhaseDone}
		if len(phases) != 4 || tests != 1 {
			t.Fatalf("%v tests=%d", phases, tests)
		}
		for i := range want {
			if phases[i] != want[i] {
				t.Fatalf("%v", phases)
			}
		}
	})
	t.Run("heartbeat: hb:<worker> holds JSON and expires within 10 s", func(t *testing.T) {
		waitFor(t, "heartbeat", func() bool { return rdb.Exists(ctx, HeartbeatKey("w1")).Val() == 1 })
		var hb Heartbeat
		if err := json.Unmarshal([]byte(rdb.Get(ctx, HeartbeatKey("w1")).Val()), &hb); err != nil || hb.WorkerID != "w1" || len(hb.Lanes) != 1 || hb.Lanes[0] != "practice" || hb.Concurrency != 1 {
			t.Fatalf("%+v %v", hb, err)
		}
		if ttl := rdb.TTL(ctx, HeartbeatKey("w1")).Val(); ttl <= 0 || ttl > HeartbeatTTL {
			t.Fatalf("ttl %v", ttl)
		}
	})
}

func TestInvalidJobsAreDeadLettered(t *testing.T) {
	rdb := startRedis(t)
	ctx := context.Background()
	ex := &fakeExec{}
	start(t, rdb, ex, nil)
	rdb.XAdd(ctx, &redis.XAddArgs{Stream: "jobs:practice", Values: map[string]any{FieldJob: `{"jobId":"x"}`}})
	rdb.XAdd(ctx, &redis.XAddArgs{Stream: "jobs:practice", Values: map[string]any{"other": "field"}})
	waitFor(t, "dead letters", func() bool { return streamLen(rdb, DLQKey) == 2 })
	waitFor(t, "ack", func() bool { return pending(rdb, "jobs:practice") == 0 })
	if ex.calls.Load() != 0 || streamLen(rdb, ResultsKey) != 0 || streamLen(rdb, "jobs:practice") != 0 {
		t.Fatalf("calls=%d results=%d", ex.calls.Load(), streamLen(rdb, ResultsKey))
	}
	e := rdb.XRange(ctx, DLQKey, "-", "+").Val()[0].Values
	if e["reason"] != "invalid-job" || e["lane"] != "practice" || e["workerId"] != "w1" {
		t.Fatalf("%v", e)
	}
}

func TestRetriesAndDeadLetter(t *testing.T) {
	ctx := context.Background()
	t.Run("FR-QUEUE-04: an infrastructure error is retried, then a verdict is published", func(t *testing.T) {
		rdb := startRedis(t)
		ex := &fakeExec{fn: func(call int, _ contracts.JudgeJob) (*judge.Outcome, error) {
			if call < 3 {
				return nil, errors.New("sandbox: isolate failed")
			}
			return &judge.Outcome{Verdict: contracts.VerdictAC}, nil
		}}
		start(t, rdb, ex, nil)
		enqueue(t, rdb, validJob("1"))
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		if r := results(t, rdb)[0]; r.Verdict != contracts.VerdictAC || ex.calls.Load() != 3 || streamLen(rdb, DLQKey) != 0 {
			t.Fatalf("%+v calls=%d", r, ex.calls.Load())
		}
	})
	t.Run("FR-QUEUE-04: after 3 failed attempts the submission gets SE and the job goes to the DLQ", func(t *testing.T) {
		rdb := startRedis(t)
		ex := &fakeExec{fn: func(int, contracts.JudgeJob) (*judge.Outcome, error) {
			return nil, errors.New("sandbox: isolate failed")
		}}
		start(t, rdb, ex, nil)
		enqueue(t, rdb, validJob("1"))
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		waitFor(t, "ack", func() bool { return pending(rdb, "jobs:practice") == 0 })
		r := results(t, rdb)[0]
		if r.Verdict != contracts.VerdictSE || r.SubmissionID != "sub-1" || ex.calls.Load() != 3 || streamLen(rdb, DLQKey) != 1 {
			t.Fatalf("%+v calls=%d dlq=%d", r, ex.calls.Load(), streamLen(rdb, DLQKey))
		}
		if e := rdb.XRange(ctx, DLQKey, "-", "+").Val()[0].Values; e["reason"] != "execution-failed" {
			t.Fatalf("%v", e)
		}
	})
	t.Run("a permanent error is not retried", func(t *testing.T) {
		rdb := startRedis(t)
		ex := &fakeExec{fn: func(int, contracts.JudgeJob) (*judge.Outcome, error) { return nil, judge.ErrUnknownLanguage }}
		start(t, rdb, ex, nil)
		enqueue(t, rdb, validJob("1"))
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		if ex.calls.Load() != 1 || results(t, rdb)[0].Verdict != contracts.VerdictSE || streamLen(rdb, DLQKey) != 1 {
			t.Fatalf("calls=%d", ex.calls.Load())
		}
	})
	t.Run("FR-JUDGE-06: a jury error is an SE verdict (no DLQ) and is counted for the alert", func(t *testing.T) {
		rdb := startRedis(t)
		ex := &fakeExec{fn: func(int, contracts.JudgeJob) (*judge.Outcome, error) {
			return &judge.Outcome{Verdict: contracts.VerdictSE, JuryError: "checker failed"}, nil
		}}
		reader := metric.NewManualReader()
		start(t, rdb, ex, func(c *Config) { c.Meter = metric.NewMeterProvider(metric.WithReader(reader)).Meter("t") })
		enqueue(t, rdb, validJob("1"))
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		if results(t, rdb)[0].Verdict != contracts.VerdictSE || streamLen(rdb, DLQKey) != 0 {
			t.Fatal("a jury error should publish SE without dead-lettering")
		}
		waitFor(t, "metric", func() bool { return counterValue(t, reader, "ca_judge_jury_errors_total") == 1 })
	})
}

func TestGracefulShutdown(t *testing.T) {
	rdb := startRedis(t)
	ex := &fakeExec{started: make(chan string, 4), release: make(chan struct{})}
	_, cancel, done := start(t, rdb, ex, nil)
	enqueue(t, rdb, validJob("1"))
	<-ex.started
	enqueue(t, rdb, validJob("2")) // arrives while job 1 is being judged
	cancel()                       // SIGTERM

	t.Run("J-05: shutdown waits for the running job and does not claim another", func(t *testing.T) {
		select {
		case <-done:
			t.Fatal("Run returned while a job was still being judged")
		case <-time.After(400 * time.Millisecond):
		}
		close(ex.release)
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Run did not return after the job finished")
		}
		rs := results(t, rdb)
		if len(rs) != 1 || rs[0].SubmissionID != "sub-1" {
			t.Fatalf("%+v", rs)
		}
		if ex.calls.Load() != 1 {
			t.Fatalf("a second job was claimed during shutdown (%d calls)", ex.calls.Load())
		}
		if streamLen(rdb, "jobs:practice") != 1 || pending(rdb, "jobs:practice") != 0 {
			t.Fatal("job 2 should still be waiting, unclaimed, for another worker")
		}
	})
}

func TestDrainTimeoutAndRestart(t *testing.T) {
	rdb := startRedis(t)
	ex := &fakeExec{started: make(chan string, 4), release: make(chan struct{})}
	_, cancel, done := start(t, rdb, ex, func(c *Config) { c.DrainTimeout = 300 * time.Millisecond })
	enqueue(t, rdb, validJob("1"))
	<-ex.started
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not give up after the drain timeout")
	}
	t.Run("an interrupted job is left pending, not lost and not given a verdict", func(t *testing.T) {
		if streamLen(rdb, ResultsKey) != 0 || pending(rdb, "jobs:practice") != 1 {
			t.Fatalf("results=%d pending=%d", streamLen(rdb, ResultsKey), pending(rdb, "jobs:practice"))
		}
	})
	t.Run("a restarted worker with the same id resumes it and publishes one result", func(t *testing.T) {
		start(t, rdb, &fakeExec{}, nil)
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		waitFor(t, "ack", func() bool { return pending(rdb, "jobs:practice") == 0 })
		if rs := results(t, rdb); len(rs) != 1 || rs[0].SubmissionID != "sub-1" || rs[0].Verdict != contracts.VerdictAC {
			t.Fatalf("%+v", rs)
		}
	})
}

func TestConcurrency(t *testing.T) {
	rdb := startRedis(t)
	ex := &fakeExec{started: make(chan string, 4), release: make(chan struct{})}
	start(t, rdb, ex, func(c *Config) { c.Concurrency = 2 })
	enqueue(t, rdb, validJob("1"))
	enqueue(t, rdb, validJob("2"))
	for i := 0; i < 2; i++ {
		select {
		case <-ex.started:
		case <-time.After(5 * time.Second):
			t.Fatal("two jobs never ran at the same time")
		}
	}
	waitFor(t, "busy=2 heartbeat", func() bool {
		var hb Heartbeat
		_ = json.Unmarshal([]byte(rdb.Get(context.Background(), HeartbeatKey("w1")).Val()), &hb)
		return hb.Busy == 2
	})
	close(ex.release)
	waitFor(t, "results", func() bool { return streamLen(rdb, ResultsKey) == 2 })
	time.Sleep(300 * time.Millisecond) // a duplicate judging would show up by now
	if ex.calls.Load() != 2 || streamLen(rdb, ResultsKey) != 2 {
		t.Fatalf("each job must be judged exactly once: %d executions, %d results", ex.calls.Load(), streamLen(rdb, ResultsKey))
	}
}

func TestTelemetry(t *testing.T) {
	rdb := startRedis(t)
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	reader := metric.NewManualReader()
	otelSetPropagator()
	start(t, rdb, &fakeExec{}, func(c *Config) {
		c.Tracer = tp.Tracer("t")
		c.Meter = metric.NewMeterProvider(metric.WithReader(reader)).Meter("t")
	})
	enqueue(t, rdb, validJob("1"))
	waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
	waitFor(t, "span", func() bool { return len(rec.Ended()) == 1 })

	t.Run("a judge.job span is a child of the job's traceparent", func(t *testing.T) {
		s := rec.Ended()[0]
		if s.Name() != "judge.job" || s.SpanContext().TraceID().String() != "0af7651916cd43dd8448eb211c80319c" ||
			s.Parent().SpanID().String() != "b7ad6b7169203331" {
			t.Fatalf("%s trace=%s parent=%s", s.Name(), s.SpanContext().TraceID(), s.Parent().SpanID())
		}
	})
	t.Run("ca_judge_jobs_total counts the job by verdict and outcome", func(t *testing.T) {
		if v := counterValue(t, reader, "ca_judge_jobs_total"); v != 1 {
			t.Fatalf("got %d", v)
		}
	})
}

func otelSetPropagator() {
	// The SDK's telemetry.Setup does this in production.
	otelGlobalSetPropagator(propagation.TraceContext{})
}

func counterValue(t *testing.T, r metric.Reader, name string) int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := r.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != name {
				continue
			}
			if sum, ok := m.Data.(metricdata.Sum[int64]); ok {
				for _, dp := range sum.DataPoints {
					total += dp.Value
				}
			}
		}
	}
	return total
}
