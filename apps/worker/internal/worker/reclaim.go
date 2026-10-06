package worker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
)

// Leases and reclaim (Q-02, SD-§5.3, ADR-005).
//
// A worker judging a job refreshes its claim every LeaseEvery with
// XCLAIM … JUSTID, which resets the entry's idle time without counting a
// delivery. A job whose claim is idle longer than ReclaimIdle belonged to a
// worker that died or hung; any worker may take it over with XCLAIM
// min-idle-time ReclaimIdle, which is atomic per entry (only one taker wins)
// and does count a delivery. The reaper finds candidates with XPENDING IDLE,
// which also reports the previous owner: that is what lets it tell a crash
// (owner's heartbeat gone) from a hang.

// owner returns who currently holds a pending entry, and false if the entry is
// no longer pending (acknowledged, or deleted and dropped from the PEL).
func (w *Worker) owner(ctx context.Context, stream, id string) (string, bool, error) {
	p, err := w.cfg.Redis.XPendingExt(ctx, &redis.XPendingExtArgs{
		Stream: stream, Group: Group, Start: id, End: id, Count: 1,
	}).Result()
	if err != nil {
		return "", false, err
	}
	if len(p) == 0 || p[0].ID != id {
		return "", false, nil
	}
	return p[0].Consumer, true, nil
}

// stillOwned is the last check before publishing: the job must still be ours.
// A Redis error counts as owned so a hiccup cannot drop a finished verdict;
// a duplicate result is harmless (Q-03 dedupes on submission + run version).
func (w *Worker) stillOwned(ctx context.Context, stream, id string) bool {
	who, pending, err := w.owner(ctx, stream, id)
	if err != nil {
		return true
	}
	return pending && who == w.cfg.WorkerID
}

// keepLease refreshes the claim on one entry until ctx ends. It calls onLost,
// once, if another consumer now holds the entry or it is no longer pending.
// Transient Redis errors do not count as a lost lease.
func (w *Worker) keepLease(ctx context.Context, stream, id string, onLost func()) {
	t := time.NewTicker(w.cfg.LeaseEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if w.cfg.leaseHook != nil {
			w.cfg.leaseHook()
		}
		who, pending, err := w.owner(ctx, stream, id)
		if err != nil {
			if ctx.Err() == nil {
				w.cfg.Log.Warn("lease check failed, will retry", "entry", id, "err", err)
			}
			continue
		}
		if !pending || who != w.cfg.WorkerID {
			onLost()
			return
		}
		// JUSTID: reset the idle time without counting another delivery.
		if err := w.cfg.Redis.XClaimJustID(ctx, &redis.XClaimArgs{
			Stream: stream, Group: Group, Consumer: w.cfg.WorkerID, MinIdle: 0, Messages: []string{id},
		}).Err(); err != nil && ctx.Err() == nil {
			w.cfg.Log.Warn("lease refresh failed, will retry", "entry", id, "err", err)
		}
	}
}

func (w *Worker) leaseLost(ctx context.Context, span trace.Span, job contracts.JudgeJob, stream, id string) {
	span.SetStatus(codes.Error, "lease lost")
	w.m.leaseLost.Add(ctx, 1, metric.WithAttributes(attribute.String("lane", string(laneOfStream(stream)))))
	w.cfg.Log.Warn("another worker took this job over; abandoning it without a result",
		"entry", id, "submission", job.SubmissionID)
}

// reclaim takes over at most one job whose lease expired, scanning lanes in
// the claim's priority order. It runs at most once per ReclaimEvery across all
// of this worker's claim loops. Jobs that have crashed too many workers or
// been delivered too often are settled here (quarantine / DLQ, SE verdict)
// instead of being returned.
func (w *Worker) reclaim(ctx context.Context, order []contracts.Lane) (string, redis.XMessage, bool) {
	now := w.cfg.Now().UnixNano()
	last := w.lastReclaim.Load()
	if now-last < int64(w.cfg.ReclaimEvery) || !w.lastReclaim.CompareAndSwap(last, now) {
		return "", redis.XMessage{}, false
	}
	for _, lane := range order {
		stream := JobsKey(lane)
		stale, err := w.cfg.Redis.XPendingExt(ctx, &redis.XPendingExtArgs{
			Stream: stream, Group: Group, Idle: w.cfg.ReclaimIdle, Start: "-", End: "+", Count: 10,
		}).Result()
		if err != nil {
			if ctx.Err() == nil && !errors.Is(err, redis.Nil) {
				w.cfg.Log.Warn("reclaim scan failed", "stream", stream, "err", err)
			}
			continue
		}
		for _, p := range stale {
			msgs, err := w.cfg.Redis.XClaim(ctx, &redis.XClaimArgs{
				Stream: stream, Group: Group, Consumer: w.cfg.WorkerID, MinIdle: w.cfg.ReclaimIdle, Messages: []string{p.ID},
			}).Result()
			if err != nil || len(msgs) == 0 {
				continue // someone else took it first, or it was acknowledged meanwhile
			}
			msg := msgs[0]
			if msg.Values == nil {
				// The entry was deleted from the stream but was still pending: drop it.
				w.cfg.Redis.XAck(ctx, stream, Group, p.ID)
				continue
			}
			if w.settle(ctx, stream, msg, p) {
				continue
			}
			return stream, msg, true
		}
	}
	return "", redis.XMessage{}, false
}

// settle counts the takeover and decides the job's fate. It returns true when
// the job was quarantined or dead-lettered (nothing left to judge).
func (w *Worker) settle(ctx context.Context, stream string, msg redis.XMessage, prev redis.XPendingExt) bool {
	lane := laneOfStream(stream)
	laneAttr := metric.WithAttributes(attribute.String("lane", string(lane)))
	w.m.reclaimed.Add(ctx, 1, laneAttr)
	deliveries := prev.RetryCount + 1 // this XCLAIM counted one more

	crashes := int64(0)
	if alive, err := w.cfg.Redis.Exists(ctx, HeartbeatKey(prev.Consumer)).Result(); err == nil && alive == 0 {
		crashes, _ = w.cfg.Redis.HIncrBy(ctx, CrashesKey, stream+":"+msg.ID, 1).Result()
	} else if err == nil {
		crashes, _ = w.cfg.Redis.HGet(ctx, CrashesKey, stream+":"+msg.ID).Int64()
	}
	w.cfg.Log.Warn("took over a job whose lease expired", "entry", msg.ID, "stream", stream,
		"previousOwner", prev.Consumer, "idle", prev.Idle, "deliveries", deliveries, "crashes", crashes)

	switch {
	case crashes >= int64(w.cfg.CrashesToQuarantine):
		w.m.quarantined.Add(ctx, 1, laneAttr)
		w.cfg.Log.Error("ALERT job quarantined: it crashed workers repeatedly", "entry", msg.ID, "crashes", crashes)
		w.settleSE(ctx, stream, msg, QuarantineKey, "crashed-workers",
			fmt.Errorf("worker processes died %d times while judging this job", crashes))
		return true
	case deliveries > int64(w.cfg.MaxDeliveries):
		w.m.dlq.Add(ctx, 1, metric.WithAttributes(attribute.String("lane", string(lane)), attribute.String("reason", "max-deliveries")))
		w.cfg.Log.Error("ALERT job dead-lettered: delivered too many times", "entry", msg.ID, "deliveries", deliveries)
		w.settleSE(ctx, stream, msg, DLQKey, "max-deliveries",
			fmt.Errorf("delivered %d times without finishing (limit %d)", deliveries, w.cfg.MaxDeliveries))
		return true
	}
	return false
}

// settleSE parks the job in an admin stream and gives its submission an SE
// verdict so the user is not left waiting. A job that cannot even be parsed
// takes the invalid-job path instead (it has no submission to answer).
func (w *Worker) settleSE(ctx context.Context, stream string, msg redis.XMessage, parkIn, reason string, cause error) {
	raw, _ := msg.Values[FieldJob].(string)
	job, err := ParseJob(raw)
	if err != nil {
		w.deadLetter(ctx, stream, msg, raw, "invalid-job", err)
		return
	}
	if err := w.cfg.Redis.XAdd(ctx, &redis.XAddArgs{Stream: parkIn, Values: map[string]any{
		"job": raw, "reason": reason, "error": cause.Error(), "workerId": w.cfg.WorkerID,
		"lane": string(laneOfStream(stream)), "entry": msg.ID, "ts": w.cfg.Now().UnixMilli(),
	}}).Err(); err != nil {
		w.cfg.Log.Error("could not park the job; leaving it pending", "entry", msg.ID, "err", err)
		return
	}
	result := ToResult(job, &judge.Outcome{Verdict: contracts.VerdictSE}, w.cfg.WorkerID, w.cfg.Now().UnixMilli())
	if err := w.publishResult(ctx, stream, msg.ID, result); err != nil {
		w.cfg.Log.Error("could not publish the SE result", "entry", msg.ID, "err", err)
	}
	w.m.jobs.Add(ctx, 1, metric.WithAttributes(attribute.String("lane", string(job.Lane)),
		attribute.String("verdict", string(contracts.VerdictSE)), attribute.String("outcome", reason)))
}
