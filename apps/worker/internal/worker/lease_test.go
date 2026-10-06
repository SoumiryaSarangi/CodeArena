package worker

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/sdk/metric"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

// fast shrinks the lease timings so takeovers happen in well under a second.
func fast(c *Config) {
	c.LeaseEvery = 100 * time.Millisecond
	c.ReclaimIdle = 400 * time.Millisecond
	c.ReclaimEvery = 100 * time.Millisecond
	c.Block = 100 * time.Millisecond
}

// ghostTake makes consumer `ghost` read the next entry of the practice stream
// and never acknowledge it: a worker that died (or hung) holding the job.
func ghostTake(t *testing.T, rdb *redis.Client, ghost string) string {
	t.Helper()
	ctx := context.Background()
	stream := JobsKey(contracts.LanePractice)
	if err := rdb.XGroupCreateMkStream(ctx, stream, Group, "0").Err(); err != nil && err.Error() != "BUSYGROUP Consumer Group name already exists" {
		t.Fatal(err)
	}
	res, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{Group: Group, Consumer: ghost, Streams: []string{stream, ">"}, Count: 1, Block: -1}).Result()
	if err != nil || len(res) == 0 || len(res[0].Messages) == 0 {
		t.Fatalf("ghost could not take a job: %v", err)
	}
	return res[0].Messages[0].ID
}

func pendingInfo(t *testing.T, rdb *redis.Client, stream, id string) redis.XPendingExt {
	t.Helper()
	p, err := rdb.XPendingExt(context.Background(), &redis.XPendingExtArgs{Stream: stream, Group: Group, Start: id, End: id, Count: 1}).Result()
	if err != nil || len(p) != 1 {
		t.Fatalf("entry %s not pending: %v", id, err)
	}
	return p[0]
}

func TestLeaseRefresh(t *testing.T) {
	t.Run("FR-QUEUE-03: while judging, the claim stays fresh and no extra delivery is counted", func(t *testing.T) {
		rdb := startRedis(t)
		ex := &fakeExec{started: make(chan string, 1), release: make(chan struct{})}
		start(t, rdb, ex, fast)
		id := enqueue(t, rdb, validJob("1"))
		<-ex.started
		time.Sleep(1200 * time.Millisecond) // three times the reclaim limit
		p := pendingInfo(t, rdb, JobsKey(contracts.LanePractice), id)
		if p.Consumer != "w1" || p.RetryCount != 1 || p.Idle > 300*time.Millisecond {
			t.Fatalf("owner=%s deliveries=%d idle=%s", p.Consumer, p.RetryCount, p.Idle)
		}
		close(ex.release)
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
	})
	t.Run("a reclaim limit not well above the lease interval is rejected", func(t *testing.T) {
		_, err := New(Config{Redis: redis.NewClient(&redis.Options{}), Exec: &fakeExec{}, LeaseEvery: time.Second, ReclaimIdle: 2 * time.Second})
		if err == nil {
			t.Fatal("accepted")
		}
	})
}

func TestReclaim(t *testing.T) {
	ctx := context.Background()
	stream := JobsKey(contracts.LanePractice)

	t.Run("FR-QUEUE-03: a job held by a dead worker is taken over and judged exactly once", func(t *testing.T) {
		rdb := startRedis(t)
		enqueue(t, rdb, validJob("1"))
		ghostTake(t, rdb, "ghost") // no heartbeat: crashed
		reader := metric.NewManualReader()
		ex := &fakeExec{}
		start(t, rdb, ex, func(c *Config) { fast(c); c.Meter = metric.NewMeterProvider(metric.WithReader(reader)).Meter("t") })
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		time.Sleep(300 * time.Millisecond)
		if ex.calls.Load() != 1 || streamLen(rdb, ResultsKey) != 1 || pending(rdb, stream) != 0 || streamLen(rdb, stream) != 0 {
			t.Fatalf("calls=%d results=%d pending=%d", ex.calls.Load(), streamLen(rdb, ResultsKey), pending(rdb, stream))
		}
		if counterValue(t, reader, "ca_queue_reclaimed_total") != 1 {
			t.Fatal("takeover not counted")
		}
		if rdb.HLen(ctx, CrashesKey).Val() != 0 {
			t.Fatal("crash counter not cleaned up after the job finished")
		}
	})

	t.Run("FR-QUEUE-04: a takeover counts a delivery in Redis (so repeated takeovers reach the DLQ)", func(t *testing.T) {
		rdb := startRedis(t)
		id := enqueue(t, rdb, validJob("1"))
		ghostTake(t, rdb, "ghost")
		ex := &fakeExec{started: make(chan string, 1), release: make(chan struct{})}
		start(t, rdb, ex, fast)
		<-ex.started
		if p := pendingInfo(t, rdb, stream, id); p.Consumer != "w1" || p.RetryCount != 2 {
			t.Fatalf("after one takeover: owner=%s deliveries=%d, want w1 and 2", p.Consumer, p.RetryCount)
		}
		close(ex.release)
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
	})

	t.Run("a fresh claim is never taken over", func(t *testing.T) {
		rdb := startRedis(t)
		ex := &fakeExec{started: make(chan string, 1), release: make(chan struct{})}
		start(t, rdb, ex, func(c *Config) { fast(c); c.WorkerID = "w1" })
		enqueue(t, rdb, validJob("1"))
		<-ex.started // w1 holds the job; only now does a second worker appear
		ex2 := &fakeExec{}
		start(t, rdb, ex2, func(c *Config) { fast(c); c.WorkerID = "w2" })
		time.Sleep(1500 * time.Millisecond)
		if ex2.calls.Load() != 0 {
			t.Fatal("a second worker took over a job whose lease was being refreshed")
		}
		close(ex.release)
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
	})

	t.Run("FR-QUEUE-05: a job that crashed a second worker is quarantined with an SE verdict", func(t *testing.T) {
		rdb := startRedis(t)
		enqueue(t, rdb, validJob("1"))
		id := ghostTake(t, rdb, "ghost")
		rdb.HSet(ctx, CrashesKey, stream+":"+id, 1) // it already killed one worker before
		reader := metric.NewManualReader()
		ex := &fakeExec{}
		start(t, rdb, ex, func(c *Config) { fast(c); c.Meter = metric.NewMeterProvider(metric.WithReader(reader)).Meter("t") })
		waitFor(t, "quarantine", func() bool { return streamLen(rdb, QuarantineKey) == 1 })
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		if ex.calls.Load() != 0 {
			t.Fatal("a quarantined job was judged")
		}
		if r := results(t, rdb)[0]; r.Verdict != contracts.VerdictSE || r.SubmissionID != "sub-1" {
			t.Fatalf("%+v", r)
		}
		e := rdb.XRange(ctx, QuarantineKey, "-", "+").Val()[0].Values
		if e["reason"] != "crashed-workers" || pending(rdb, stream) != 0 || streamLen(rdb, stream) != 0 || rdb.HLen(ctx, CrashesKey).Val() != 0 {
			t.Fatalf("entry=%v pending=%d", e, pending(rdb, stream))
		}
		if counterValue(t, reader, "ca_queue_quarantined_total") != 1 {
			t.Fatal("quarantine not counted")
		}
	})

	t.Run("FR-QUEUE-05: a hung worker (heartbeat still alive) is not counted as a crash", func(t *testing.T) {
		rdb := startRedis(t)
		enqueue(t, rdb, validJob("1"))
		id := ghostTake(t, rdb, "hung")
		rdb.Set(ctx, HeartbeatKey("hung"), "{}", time.Minute)
		rdb.HSet(ctx, CrashesKey, stream+":"+id, 1)
		ex := &fakeExec{}
		start(t, rdb, ex, fast)
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		if ex.calls.Load() != 1 || streamLen(rdb, QuarantineKey) != 0 || results(t, rdb)[0].Verdict != contracts.VerdictAC {
			t.Fatal("a takeover from a live worker was treated as a crash")
		}
	})

	t.Run("FR-QUEUE-04: after more than 3 deliveries the job goes to the DLQ with an SE verdict", func(t *testing.T) {
		rdb := startRedis(t)
		enqueue(t, rdb, validJob("1"))
		id := ghostTake(t, rdb, "g1")            // delivery 1
		for _, g := range []string{"g2", "g3"} { // deliveries 2 and 3 (live workers that each gave up)
			rdb.XClaim(ctx, &redis.XClaimArgs{Stream: stream, Group: Group, Consumer: g, MinIdle: 0, Messages: []string{id}})
			rdb.Set(ctx, HeartbeatKey(g), "{}", time.Minute)
		}
		if p := pendingInfo(t, rdb, stream, id); p.RetryCount != 3 {
			t.Fatalf("setup: deliveries=%d", p.RetryCount)
		}
		reader := metric.NewManualReader()
		ex := &fakeExec{}
		start(t, rdb, ex, func(c *Config) { fast(c); c.Meter = metric.NewMeterProvider(metric.WithReader(reader)).Meter("t") })
		waitFor(t, "dlq", func() bool { return streamLen(rdb, DLQKey) == 1 })
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		e := rdb.XRange(ctx, DLQKey, "-", "+").Val()[0].Values
		if e["reason"] != "max-deliveries" || ex.calls.Load() != 0 || results(t, rdb)[0].Verdict != contracts.VerdictSE || pending(rdb, stream) != 0 {
			t.Fatalf("entry=%v calls=%d", e, ex.calls.Load())
		}
		if counterValue(t, reader, "ca_queue_dlq_total") != 1 {
			t.Fatal("dead letter not counted")
		}
	})

	t.Run("a job on its 3rd delivery is still judged", func(t *testing.T) {
		rdb := startRedis(t)
		enqueue(t, rdb, validJob("1"))
		id := ghostTake(t, rdb, "g1")
		rdb.XClaim(ctx, &redis.XClaimArgs{Stream: stream, Group: Group, Consumer: "g2", MinIdle: 0, Messages: []string{id}})
		rdb.Set(ctx, HeartbeatKey("g2"), "{}", time.Minute)
		ex := &fakeExec{}
		start(t, rdb, ex, fast)
		waitFor(t, "result", func() bool { return streamLen(rdb, ResultsKey) == 1 })
		if ex.calls.Load() != 1 || streamLen(rdb, DLQKey) != 0 {
			t.Fatal("the 3rd delivery should be judged, not dead-lettered")
		}
	})

	t.Run("reclaimed jobs keep lane priority: the scan takes the stale contest job before the stale practice one", func(t *testing.T) {
		rdb := startRedis(t)
		enqueue(t, rdb, laneJob("p", contracts.LanePractice))
		enqueue(t, rdb, laneJob("c", contracts.LaneContest))
		for _, lane := range []contracts.Lane{contracts.LanePractice, contracts.LaneContest} {
			rdb.XGroupCreateMkStream(ctx, JobsKey(lane), Group, "0")
			rdb.XReadGroup(ctx, &redis.XReadGroupArgs{Group: Group, Consumer: "ghost", Streams: []string{JobsKey(lane), ">"}, Count: 1})
		}
		time.Sleep(500 * time.Millisecond) // both are now stale
		cfg := Config{Redis: rdb, Exec: &fakeExec{}, WorkerID: "w1", Lanes: allLanes, Log: quiet()}
		fast(&cfg)
		w, err := New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		top := []contracts.Lane{contracts.LaneContest, contracts.LaneInteractive, contracts.LanePractice, contracts.LaneRejudge}
		if got, _, ok := w.reclaim(ctx, top); !ok || got != JobsKey(contracts.LaneContest) {
			t.Fatalf("first takeover came from %q (ok=%v), want the contest stream", got, ok)
		}
		w.lastReclaim.Store(0)
		low := []contracts.Lane{contracts.LaneRejudge, contracts.LanePractice, contracts.LaneInteractive, contracts.LaneContest}
		if got, _, ok := w.reclaim(ctx, low); !ok || got != JobsKey(contracts.LanePractice) {
			t.Fatalf("with a lowest-first order the takeover came from %q (ok=%v), want practice", got, ok)
		}
	})
}

func TestLeaseLost(t *testing.T) {
	t.Run("FR-QUEUE-07: a worker that stalled and was taken over abandons the job and publishes nothing", func(t *testing.T) {
		rdb := startRedis(t)
		ctx := context.Background()
		stream := JobsKey(contracts.LanePractice)
		ex := &fakeExec{started: make(chan string, 1), release: make(chan struct{})}
		reader := metric.NewManualReader()
		var paused atomic.Bool
		resume := make(chan struct{})
		start(t, rdb, ex, func(c *Config) {
			fast(c)
			c.Meter = metric.NewMeterProvider(metric.WithReader(reader)).Meter("t")
			c.leaseHook = func() {
				if paused.Load() {
					<-resume // the worker stalls here: no lease refresh
				}
			}
		})
		id := enqueue(t, rdb, validJob("1"))
		<-ex.started
		paused.Store(true)
		time.Sleep(700 * time.Millisecond) // the claim goes stale (> 400 ms without a refresh)
		// another worker takes it over exactly as the reaper does: only because it is stale
		taken, err := rdb.XClaim(ctx, &redis.XClaimArgs{Stream: stream, Group: Group, Consumer: "other",
			MinIdle: 400 * time.Millisecond, Messages: []string{id}}).Result()
		if err != nil || len(taken) != 1 {
			t.Fatalf("the stale job could not be taken over: %v", err)
		}
		paused.Store(false)
		close(resume) // the stalled worker wakes up
		waitFor(t, "lease lost", func() bool { return counterValue(t, reader, "ca_queue_lease_lost_total") == 1 })
		time.Sleep(200 * time.Millisecond)
		if streamLen(rdb, ResultsKey) != 0 {
			t.Fatal("the worker that lost its lease still published a result")
		}
	})
}
