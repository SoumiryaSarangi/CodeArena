package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/lanes"
)

// Redis names (SD-§7).
const (
	Group         = "judges"
	ResultsKey    = "results"
	DLQKey        = "jobs:dlq"
	QuarantineKey = "jobs:quarantine"
	// CrashesKey counts, per job entry, how many workers died holding it
	// (field "<stream>:<entry id>"). It lives under jobs:* because that is all
	// the judge's Redis ACL allows (ADR-009).
	CrashesKey = "jobs:crashes"
)

// JobsKey is the stream for a lane.
func JobsKey(l contracts.Lane) string { return "jobs:" + string(l) }

func laneOfStream(stream string) contracts.Lane {
	return contracts.Lane(strings.TrimPrefix(stream, "jobs:"))
}

// ProgressChannel is the pub/sub channel for one submission.
func ProgressChannel(submissionID string) string { return "progress:" + submissionID }

// HeartbeatKey is the worker's liveness key.
func HeartbeatKey(workerID string) string { return "hb:" + workerID }

const HeartbeatTTL = 10 * time.Second

// Config sets up a Worker. Zero values pick the defaults noted.
type Config struct {
	Redis *redis.Client
	Exec  Executor
	// Lanes are the streams this worker serves (default: practice). It claims
	// in strict priority order with the every-8th-claim fairness rule (Q-01,
	// FR-QUEUE-02); see internal/lanes.
	Lanes          []contracts.Lane
	WorkerID       string        // hostname
	Concurrency    int           // 1 job at a time
	Block          time.Duration // 2 s: how long one XREADGROUP waits
	HeartbeatEvery time.Duration // 3 s (TTL is 10 s)
	JobTimeout     time.Duration // 10 min per attempt
	DrainTimeout   time.Duration // 2 min: how long shutdown waits for running jobs
	MaxAttempts    int           // 3 judging attempts for infrastructure errors
	RetryBackoff   time.Duration // 1 s x attempt
	// Leases (Q-02, FR-QUEUE-03): a judging worker refreshes its claim every
	// LeaseEvery; a job whose claim is idle longer than ReclaimIdle is taken
	// over by another worker, which looks for such jobs every ReclaimEvery.
	LeaseEvery          time.Duration // 2 s
	ReclaimIdle         time.Duration // 10 s
	ReclaimEvery        time.Duration // LeaseEvery
	MaxDeliveries       int           // 3: the 4th delivery goes to the DLQ (FR-QUEUE-04)
	CrashesToQuarantine int           // 2 (FR-QUEUE-05)

	// leaseHook, if set (tests only), runs before each lease check; a test
	// blocks in it to simulate a worker that stalls.
	leaseHook func()
	Now       func() time.Time
	Log       *slog.Logger
	Tracer    trace.Tracer
	Meter     metric.Meter
}

// Worker consumes one lane.
type Worker struct {
	cfg         Config
	picker      *lanes.Picker
	busy        atomic.Int64
	m           instruments
	lastReclaim atomic.Int64 // unix nanos of the last reclaim scan, shared by all claim loops
}

type instruments struct {
	reclaimed   metric.Int64Counter
	dlq         metric.Int64Counter
	quarantined metric.Int64Counter
	leaseLost   metric.Int64Counter
	jobs        metric.Int64Counter
	seconds     metric.Float64Histogram
	inflight    metric.Int64UpDownCounter
	jury        metric.Int64Counter
}

// New applies defaults and builds the metrics.
func New(cfg Config) (*Worker, error) {
	if cfg.Redis == nil || cfg.Exec == nil {
		return nil, errors.New("worker: redis and executor are required")
	}
	if len(cfg.Lanes) == 0 {
		cfg.Lanes = []contracts.Lane{contracts.LanePractice}
	}
	picker, err := lanes.New(cfg.Lanes, 0)
	if err != nil {
		return nil, err
	}
	cfg.Lanes = picker.Lanes() // normalised to priority order
	if cfg.WorkerID == "" {
		h, _ := os.Hostname()
		cfg.WorkerID = h
	}
	if cfg.WorkerID == "" || strings.ContainsAny(cfg.WorkerID, " \t\n:*?[]") {
		return nil, errors.New("worker: bad worker id")
	}
	cfg.Concurrency = orInt(cfg.Concurrency, 1)
	cfg.MaxAttempts = orInt(cfg.MaxAttempts, 3)
	cfg.Block = orDur(cfg.Block, 2*time.Second)
	cfg.HeartbeatEvery = orDur(cfg.HeartbeatEvery, 3*time.Second)
	cfg.JobTimeout = orDur(cfg.JobTimeout, 10*time.Minute)
	cfg.DrainTimeout = orDur(cfg.DrainTimeout, 2*time.Minute)
	cfg.RetryBackoff = orDur(cfg.RetryBackoff, time.Second)
	cfg.LeaseEvery = orDur(cfg.LeaseEvery, 2*time.Second)
	cfg.ReclaimIdle = orDur(cfg.ReclaimIdle, 10*time.Second)
	cfg.ReclaimEvery = orDur(cfg.ReclaimEvery, cfg.LeaseEvery)
	cfg.MaxDeliveries = orInt(cfg.MaxDeliveries, 3)
	cfg.CrashesToQuarantine = orInt(cfg.CrashesToQuarantine, 2)
	if cfg.ReclaimIdle <= 2*cfg.LeaseEvery {
		return nil, fmt.Errorf("worker: ReclaimIdle (%s) must be more than twice LeaseEvery (%s), or a healthy worker's job could be taken over", cfg.ReclaimIdle, cfg.LeaseEvery)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Tracer == nil {
		cfg.Tracer = otel.Tracer("codearena/worker")
	}
	if cfg.Meter == nil {
		cfg.Meter = otel.Meter("codearena/worker")
	}
	w := &Worker{cfg: cfg, picker: picker}
	if w.m.jobs, err = cfg.Meter.Int64Counter("ca_judge_jobs_total", metric.WithDescription("Judge jobs finished, by lane, verdict and outcome")); err != nil {
		return nil, err
	}
	if w.m.seconds, err = cfg.Meter.Float64Histogram("ca_judge_job_seconds", metric.WithUnit("s"), metric.WithDescription("Wall time from claim to published result")); err != nil {
		return nil, err
	}
	if w.m.inflight, err = cfg.Meter.Int64UpDownCounter("ca_judge_inflight", metric.WithDescription("Jobs being judged right now")); err != nil {
		return nil, err
	}
	if w.m.jury, err = cfg.Meter.Int64Counter("ca_judge_jury_errors_total", metric.WithDescription("Checker failures (SE + alert)")); err != nil {
		return nil, err
	}
	if w.m.reclaimed, err = cfg.Meter.Int64Counter("ca_queue_reclaimed_total", metric.WithDescription("Jobs taken over after their lease expired")); err != nil {
		return nil, err
	}
	if w.m.dlq, err = cfg.Meter.Int64Counter("ca_queue_dlq_total", metric.WithDescription("Jobs moved to the dead-letter stream, by reason (alert)")); err != nil {
		return nil, err
	}
	if w.m.quarantined, err = cfg.Meter.Int64Counter("ca_queue_quarantined_total", metric.WithDescription("Jobs quarantined after crashing workers (alert)")); err != nil {
		return nil, err
	}
	if w.m.leaseLost, err = cfg.Meter.Int64Counter("ca_queue_lease_lost_total", metric.WithDescription("Jobs abandoned because another worker took them over")); err != nil {
		return nil, err
	}
	return w, nil
}

func orInt(v, d int) int {
	if v <= 0 {
		return d
	}
	return v
}

func orDur(v, d time.Duration) time.Duration {
	if v <= 0 {
		return d
	}
	return v
}

// Run reads jobs until ctx is cancelled. Cancelling stops new claims only:
// jobs already running finish and publish their result (up to DrainTimeout)
// before Run returns, so a deploy or Ctrl-C never abandons a half-judged job.
func (w *Worker) Run(ctx context.Context) error {
	for _, lane := range w.cfg.Lanes {
		err := w.cfg.Redis.XGroupCreateMkStream(ctx, JobsKey(lane), Group, "0").Err()
		if err != nil && !strings.HasPrefix(err.Error(), "BUSYGROUP") {
			return fmt.Errorf("worker: create group on %s: %w", JobsKey(lane), err)
		}
	}

	// hardCtx lives until shutdown has drained; judging uses it, not ctx.
	hardCtx, hardCancel := context.WithCancel(context.WithoutCancel(ctx))
	defer hardCancel()
	go func() {
		<-ctx.Done()
		t := time.NewTimer(w.cfg.DrainTimeout)
		defer t.Stop()
		select {
		case <-t.C:
			w.cfg.Log.Warn("drain timeout: cancelling running jobs", "after", w.cfg.DrainTimeout)
			hardCancel()
		case <-hardCtx.Done():
		}
	}()

	hbCtx, hbCancel := context.WithCancel(context.WithoutCancel(ctx))
	var hb sync.WaitGroup
	hb.Add(1)
	go func() { defer hb.Done(); w.heartbeat(hbCtx) }()

	// Resume entries this consumer name read before a restart but never
	// acknowledged. This must finish before any claiming loop starts: the
	// loops share the consumer name, so a later "my pending entries" read
	// would also return jobs a sibling loop is judging right now.
	for _, lane := range w.cfg.Lanes {
		w.resumePending(ctx, hardCtx, JobsKey(lane))
	}

	var wg sync.WaitGroup
	for i := 0; i < w.cfg.Concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.consume(ctx, hardCtx)
		}()
	}
	wg.Wait()
	hbCancel()
	hb.Wait()
	return nil
}

// consume is one claiming loop.
func (w *Worker) consume(ctx, hardCtx context.Context) {
	for ctx.Err() == nil {
		stream, msg, ok := w.claim(ctx)
		if ok {
			w.handle(hardCtx, stream, msg)
		}
	}
}

// claim takes one job. It probes each lane without blocking in the order the
// picker gives (priority, or lowest-first on every 8th claim) and takes the
// first job found. If every lane is empty it waits on all of them at once and
// takes whatever arrives first.
func (w *Worker) claim(ctx context.Context) (stream string, msg redis.XMessage, ok bool) {
	order := w.picker.Next() // one fairness step per claim, shared by reclaim and new jobs
	if stream, msg, ok := w.reclaim(ctx, order); ok {
		return stream, msg, true
	}
	for _, lane := range order {
		if m, found := w.read(ctx, []string{JobsKey(lane)}, -1); found {
			return JobsKey(lane), m.msg, true
		}
		if ctx.Err() != nil {
			return "", redis.XMessage{}, false
		}
	}
	streams := make([]string, 0, len(w.cfg.Lanes))
	for _, lane := range w.cfg.Lanes {
		streams = append(streams, JobsKey(lane))
	}
	block := w.cfg.Block
	if block > w.cfg.ReclaimEvery {
		block = w.cfg.ReclaimEvery // wake up in time for the next reclaim scan
	}
	if m, found := w.read(ctx, streams, block); found {
		return m.stream, m.msg, true
	}
	return "", redis.XMessage{}, false
}

type claimed struct {
	stream string
	msg    redis.XMessage
}

// read does one XREADGROUP on the given streams. block < 0 means do not block.
func (w *Worker) read(ctx context.Context, streams []string, block time.Duration) (claimed, bool) {
	args := append([]string{}, streams...)
	for range streams {
		args = append(args, ">")
	}
	res, err := w.cfg.Redis.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group: Group, Consumer: w.cfg.WorkerID, Streams: args, Count: 1, Block: block,
	}).Result()
	if err != nil {
		if ctx.Err() == nil && !errors.Is(err, redis.Nil) {
			w.cfg.Log.Error("read jobs", "err", err)
			sleep(ctx, time.Second)
		}
		return claimed{}, false
	}
	for _, s := range res {
		if len(s.Messages) > 0 {
			return claimed{stream: s.Stream, msg: s.Messages[0]}, true
		}
	}
	return claimed{}, false
}

// resumePending walks this consumer's pending entries once, using the last ID
// seen as a cursor: an entry that stays pending (interrupted again, Redis
// down) must not be returned forever.
func (w *Worker) resumePending(ctx, hardCtx context.Context, stream string) {
	cursor := "0"
	for ctx.Err() == nil {
		res, err := w.cfg.Redis.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: Group, Consumer: w.cfg.WorkerID, Streams: []string{stream, cursor}, Count: 10,
		}).Result()
		if err != nil || len(res) == 0 || len(res[0].Messages) == 0 {
			return
		}
		for _, m := range res[0].Messages {
			cursor = m.ID
			w.cfg.Log.Info("resuming unacknowledged job", "entry", m.ID)
			w.handle(hardCtx, stream, m)
		}
	}
}

// handle judges one stream entry and publishes exactly one result for it,
// then acknowledges and deletes the entry. Anything that stops it before the
// result is durable (shutdown timeout, Redis down) leaves the entry pending
// so it is judged again, never lost.
func (w *Worker) handle(ctx context.Context, stream string, msg redis.XMessage) {
	raw, _ := msg.Values[FieldJob].(string)
	job, err := ParseJob(raw)
	if err != nil {
		w.cfg.Log.Error("invalid job, moving to the dead-letter stream", "entry", msg.ID, "err", err)
		w.deadLetter(ctx, stream, msg, raw, "invalid-job", err)
		return
	}

	if want := laneOfStream(stream); job.Lane != want {
		// Priority comes from the stream a job is in, so a job whose lane field
		// disagrees was enqueued wrongly: never run it under the wrong label.
		err := fmt.Errorf("%w: job says lane %q but arrived on %s", ErrInvalidJob, job.Lane, stream)
		w.cfg.Log.Error("lane mismatch, moving to the dead-letter stream", "entry", msg.ID, "err", err)
		w.deadLetter(ctx, stream, msg, raw, "invalid-job", err)
		return
	}

	parent := otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier{"traceparent": job.Traceparent})
	spanCtx, span := w.cfg.Tracer.Start(parent, "judge.job", trace.WithAttributes(
		attribute.String("submission.id", job.SubmissionID), attribute.Int64("run.version", job.RunVersion),
		attribute.String("lane", string(job.Lane)), attribute.String("language", string(job.Language)),
		attribute.String("worker.id", w.cfg.WorkerID)))
	defer span.End()

	start := w.cfg.Now()
	w.busy.Add(1)
	w.m.inflight.Add(ctx, 1)
	defer func() { w.busy.Add(-1); w.m.inflight.Add(ctx, -1) }()

	// Hold a lease while judging. If another worker takes the job over (we
	// stalled past ReclaimIdle), judging is cancelled and nothing is published.
	judgeCtx, cancelJudge := context.WithCancel(spanCtx)
	defer cancelJudge()
	var lost atomic.Bool
	leaseDone := make(chan struct{})
	go func() {
		defer close(leaseDone)
		w.keepLease(judgeCtx, stream, msg.ID, func() { lost.Store(true); cancelJudge() })
	}()
	defer func() { cancelJudge(); <-leaseDone }()

	w.publishProgress(spanCtx, job, contracts.JudgePhaseClaimed, nil)
	progress := func(phase contracts.JudgePhase, t *contracts.TestOutcome) { w.publishProgress(spanCtx, job, phase, t) }

	outcome, err := w.execute(judgeCtx, job, progress)
	if lost.Load() || !w.stillOwned(ctx, stream, msg.ID) {
		w.leaseLost(ctx, span, job, stream, msg.ID)
		return
	}
	outcomeLabel := "done"
	if err != nil {
		if ctx.Err() != nil {
			// Shutdown timed out mid-job: leave it pending for another worker.
			span.SetStatus(codes.Error, "cancelled")
			w.cfg.Log.Warn("job interrupted, left pending", "entry", msg.ID, "submission", job.SubmissionID)
			return
		}
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		w.cfg.Log.Error("job failed, publishing SE and dead-lettering", "entry", msg.ID, "submission", job.SubmissionID, "err", err)
		outcome = &judge.Outcome{Verdict: contracts.VerdictSE}
		outcomeLabel = "dlq"
		w.deadLetterEntry(ctx, laneOfStream(stream), msg, raw, "execution-failed", err)
		w.m.dlq.Add(ctx, 1, metric.WithAttributes(attribute.String("lane", string(job.Lane)), attribute.String("reason", "execution-failed")))
	}
	if outcome.JuryError != "" {
		w.m.jury.Add(ctx, 1, metric.WithAttributes(attribute.String("lane", string(job.Lane))))
		w.cfg.Log.Error("ALERT jury error: a checker failed", "problem", job.Problem.VersionID, "submission", job.SubmissionID, "msg", outcome.JuryError)
	}

	result := ToResult(job, outcome, w.cfg.WorkerID, w.cfg.Now().UnixMilli())
	if err := w.publishResult(ctx, stream, msg.ID, result); err != nil {
		w.cfg.Log.Error("could not publish the result, left pending", "entry", msg.ID, "err", err)
		return
	}
	w.publishProgress(spanCtx, job, contracts.JudgePhaseDone, nil)

	span.SetAttributes(attribute.String("verdict", string(outcome.Verdict)))
	attrs := metric.WithAttributes(attribute.String("lane", string(job.Lane)),
		attribute.String("verdict", string(outcome.Verdict)), attribute.String("outcome", outcomeLabel))
	w.m.jobs.Add(ctx, 1, attrs)
	w.m.seconds.Record(ctx, w.cfg.Now().Sub(start).Seconds(), metric.WithAttributes(attribute.String("lane", string(job.Lane))))
	w.cfg.Log.Info("judged", "submission", job.SubmissionID, "run", job.RunVersion, "verdict", outcome.Verdict,
		"timeMs", outcome.TimeMS, "memKb", outcome.MemKB, "tests", len(outcome.Tests))
}

// execute runs the job with retries for non-permanent errors.
func (w *Worker) execute(ctx context.Context, job contracts.JudgeJob, progress judge.Progress) (*judge.Outcome, error) {
	var err error
	for attempt := 1; attempt <= w.cfg.MaxAttempts; attempt++ {
		jobCtx, cancel := context.WithTimeout(ctx, w.cfg.JobTimeout)
		var o *judge.Outcome
		o, err = w.cfg.Exec.Execute(jobCtx, job, progress)
		cancel()
		if err == nil {
			return o, nil
		}
		if permanent(err) || ctx.Err() != nil || attempt == w.cfg.MaxAttempts {
			break
		}
		w.cfg.Log.Warn("judging attempt failed, retrying", "submission", job.SubmissionID, "attempt", attempt, "err", err)
		sleep(ctx, w.cfg.RetryBackoff*time.Duration(attempt))
	}
	return nil, err
}

// publishResult is the commit point: XADD the result, then XACK and XDEL the
// job. It retries because losing the result would strand the submission.
func (w *Worker) publishResult(ctx context.Context, stream, id string, r contracts.JudgeResult) error {
	body, err := marshal(r)
	if err != nil {
		return err
	}
	for attempt := 1; ; attempt++ {
		_, err = w.cfg.Redis.TxPipelined(ctx, func(p redis.Pipeliner) error {
			p.XAdd(ctx, &redis.XAddArgs{Stream: ResultsKey, Values: map[string]any{FieldResult: string(body)}})
			p.XAck(ctx, stream, Group, id)
			p.XDel(ctx, stream, id)
			p.HDel(ctx, CrashesKey, stream+":"+id)
			return nil
		})
		if err == nil {
			return nil
		}
		if attempt >= 5 || ctx.Err() != nil {
			return err
		}
		sleep(ctx, w.cfg.RetryBackoff*time.Duration(attempt))
	}
}

func (w *Worker) publishProgress(ctx context.Context, job contracts.JudgeJob, phase contracts.JudgePhase, t *contracts.TestOutcome) {
	body, err := marshal(contracts.JudgeProgress{
		SubmissionID: job.SubmissionID, RunVersion: job.RunVersion, Phase: phase,
		WorkerID: w.cfg.WorkerID, Test: t, Ts: w.cfg.Now().UnixMilli(),
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	// Progress is best effort: the result is what counts.
	if err := w.cfg.Redis.Publish(ctx, ProgressChannel(job.SubmissionID), string(body)).Err(); err != nil {
		w.cfg.Log.Warn("progress publish failed", "err", err)
	}
}

// deadLetter moves an entry that could not even be parsed.
func (w *Worker) deadLetter(ctx context.Context, stream string, msg redis.XMessage, raw, reason string, cause error) {
	lane := strings.TrimPrefix(stream, "jobs:")
	w.deadLetterEntry(ctx, contracts.Lane(lane), msg, raw, reason, cause)
	w.m.dlq.Add(ctx, 1, metric.WithAttributes(attribute.String("lane", lane), attribute.String("reason", reason)))
	w.m.jobs.Add(ctx, 1, metric.WithAttributes(attribute.String("lane", lane),
		attribute.String("verdict", "none"), attribute.String("outcome", "dlq")))
}

// deadLetterEntry copies the job to jobs:dlq for an admin. For jobs that
// still get an SE result the entry is acked by publishResult; for unparseable
// ones it is acked here.
func (w *Worker) deadLetterEntry(ctx context.Context, lane contracts.Lane, msg redis.XMessage, raw, reason string, cause error) {
	stream := JobsKey(lane)
	_, err := w.cfg.Redis.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.XAdd(ctx, &redis.XAddArgs{Stream: DLQKey, Values: map[string]any{
			"job": raw, "reason": reason, "error": cause.Error(), "workerId": w.cfg.WorkerID,
			"lane": string(lane), "entry": msg.ID, "ts": w.cfg.Now().UnixMilli(),
		}})
		if reason == "invalid-job" {
			p.XAck(ctx, stream, Group, msg.ID)
			p.XDel(ctx, stream, msg.ID)
			p.HDel(ctx, CrashesKey, stream+":"+msg.ID)
		}
		return nil
	})
	if err != nil {
		w.cfg.Log.Error("dead-letter failed", "entry", msg.ID, "err", err)
	}
}

// Heartbeat is the JSON stored at hb:{workerId}.
type Heartbeat struct {
	WorkerID    string   `json:"workerId"`
	Lanes       []string `json:"lanes"`
	Ts          int64    `json:"ts"`
	Busy        int64    `json:"busy"`
	Concurrency int      `json:"concurrency"`
}

func (w *Worker) heartbeat(ctx context.Context) {
	beat := func() {
		lanes := make([]string, len(w.cfg.Lanes))
		for i, l := range w.cfg.Lanes {
			lanes[i] = string(l)
		}
		b, _ := json.Marshal(Heartbeat{WorkerID: w.cfg.WorkerID, Lanes: lanes, Ts: w.cfg.Now().UnixMilli(),
			Busy: w.busy.Load(), Concurrency: w.cfg.Concurrency})
		c, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if err := w.cfg.Redis.Set(c, HeartbeatKey(w.cfg.WorkerID), b, HeartbeatTTL).Err(); err != nil && ctx.Err() == nil {
			w.cfg.Log.Warn("heartbeat failed", "err", err)
		}
	}
	beat()
	t := time.NewTicker(w.cfg.HeartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			beat()
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
