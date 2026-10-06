package worker

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
)

func laneJob(id string, lane contracts.Lane) contracts.JudgeJob {
	j := validJob(id)
	j.Lane = lane
	return j
}

// recorder is an Executor that remembers the order jobs were judged in.
type recorder struct {
	mu    sync.Mutex
	order []string
}

func (r *recorder) Execute(_ context.Context, job contracts.JudgeJob, _ judge.Progress) (*judge.Outcome, error) {
	r.mu.Lock()
	r.order = append(r.order, string(job.Lane)[:1]+":"+job.SubmissionID)
	r.mu.Unlock()
	return &judge.Outcome{Verdict: contracts.VerdictAC}, nil
}

func (r *recorder) lanesInOrder() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var b strings.Builder
	for _, o := range r.order {
		b.WriteString(o[:1])
	}
	return b.String()
}

func (r *recorder) count() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.order) }

var allLanes = []contracts.Lane{contracts.LaneContest, contracts.LaneInteractive, contracts.LanePractice, contracts.LaneRejudge}

func TestMultiLane(t *testing.T) {
	t.Run("FR-QUEUE-02: a waiting contest job is judged before practice jobs that were enqueued first", func(t *testing.T) {
		rdb := startRedis(t)
		for i := 0; i < 3; i++ {
			enqueue(t, rdb, laneJob(fmt.Sprint("p", i), contracts.LanePractice))
		}
		enqueue(t, rdb, laneJob("c0", contracts.LaneContest))
		enqueue(t, rdb, laneJob("r0", contracts.LaneRejudge))
		rec := &recorder{}
		start(t, rdb, rec, func(c *Config) { c.Lanes = allLanes })
		waitFor(t, "5 jobs", func() bool { return rec.count() == 5 })
		// claim 1 contest, claims 2-4 practice, claim 5 rejudge: strict priority
		if got := rec.lanesInOrder(); got != "cpppr" {
			t.Fatalf("judged in lane order %q, want cpppr", got)
		}
	})

	t.Run("FR-QUEUE-02: every 8th claim goes to the lowest non-empty lane even while contest is backlogged", func(t *testing.T) {
		rdb := startRedis(t)
		for i := 0; i < 14; i++ {
			enqueue(t, rdb, laneJob(fmt.Sprint("c", i), contracts.LaneContest))
		}
		for i := 0; i < 2; i++ {
			enqueue(t, rdb, laneJob(fmt.Sprint("r", i), contracts.LaneRejudge))
		}
		rec := &recorder{}
		start(t, rdb, rec, func(c *Config) { c.Lanes = allLanes })
		waitFor(t, "16 jobs", func() bool { return rec.count() == 16 })
		// 7 contest, the 8th claim reaches down to rejudge, 7 more contest, the 16th is rejudge again
		if got := rec.lanesInOrder(); got != "cccccccrcccccccr" {
			t.Fatalf("judged in lane order %q, want cccccccrcccccccr", got)
		}
	})

	t.Run("a worker serves only the lanes it is configured for", func(t *testing.T) {
		rdb := startRedis(t)
		enqueue(t, rdb, laneJob("r0", contracts.LaneRejudge))
		enqueue(t, rdb, laneJob("p0", contracts.LanePractice))
		rec := &recorder{}
		start(t, rdb, rec, func(c *Config) { c.Lanes = []contracts.Lane{contracts.LanePractice} })
		waitFor(t, "practice job", func() bool { return rec.count() == 1 })
		time.Sleep(400 * time.Millisecond)
		if rec.count() != 1 || streamLen(rdb, JobsKey(contracts.LaneRejudge)) != 1 {
			t.Fatalf("a practice-only worker touched the rejudge lane (judged %d)", rec.count())
		}
	})

	t.Run("an idle multi-lane worker wakes up for a job on any lane", func(t *testing.T) {
		rdb := startRedis(t)
		rec := &recorder{}
		start(t, rdb, rec, func(c *Config) { c.Lanes = allLanes })
		time.Sleep(300 * time.Millisecond) // let it go idle and block
		enqueue(t, rdb, laneJob("i0", contracts.LaneInteractive))
		waitFor(t, "interactive job", func() bool { return rec.count() == 1 })
		if rec.lanesInOrder() != "i" {
			t.Fatalf("%q", rec.lanesInOrder())
		}
	})

	t.Run("a job whose lane field disagrees with its stream is dead-lettered, not run", func(t *testing.T) {
		rdb := startRedis(t)
		// a practice-labelled job smuggled into the contest stream to jump the queue
		bad := laneJob("sneaky", contracts.LanePractice)
		rdb.XAdd(context.Background(), &redis.XAddArgs{Stream: JobsKey(contracts.LaneContest), Values: map[string]any{FieldJob: encode(t, bad)}})
		rec := &recorder{}
		start(t, rdb, rec, func(c *Config) { c.Lanes = allLanes })
		waitFor(t, "dead letter", func() bool { return streamLen(rdb, DLQKey) == 1 })
		waitFor(t, "ack", func() bool { return pending(rdb, JobsKey(contracts.LaneContest)) == 0 })
		if rec.count() != 0 || streamLen(rdb, ResultsKey) != 0 {
			t.Fatal("a mislabelled job was judged")
		}
		e := rdb.XRange(context.Background(), DLQKey, "-", "+").Val()[0].Values
		if e["reason"] != "invalid-job" || e["lane"] != "contest" {
			t.Fatalf("%v", e)
		}
	})

	t.Run("a multi-lane worker resumes its own unacknowledged jobs on every lane after a restart", func(t *testing.T) {
		rdb := startRedis(t)
		ex := &fakeExec{started: make(chan string, 4), release: make(chan struct{})}
		enqueue(t, rdb, laneJob("c1", contracts.LaneContest))
		_, cancel, done := start(t, rdb, ex, func(c *Config) { c.Lanes = allLanes; c.DrainTimeout = 300 * time.Millisecond })
		<-ex.started
		cancel()
		<-done
		rec := &recorder{}
		start(t, rdb, rec, func(c *Config) { c.Lanes = allLanes })
		waitFor(t, "resumed job", func() bool { return rec.count() == 1 })
		waitFor(t, "ack", func() bool { return pending(rdb, JobsKey(contracts.LaneContest)) == 0 })
		if rec.lanesInOrder() != "c" {
			t.Fatalf("%q", rec.lanesInOrder())
		}
	})
}
