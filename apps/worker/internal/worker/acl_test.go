package worker

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

// Q-04: these tests run against a Redis started from the repository's real ACL
// file (infra/redis/users.acl.tmpl) through its real entrypoint script, so what
// is tested is what compose and production run.
const (
	adminPW = "admin-test"
	judgePW = "judge-test"
	apiPW   = "api-test"
)

// startACLRedis returns an admin client and a judge client on a fresh, flushed
// ACL-protected Redis, plus its address. Skips like startRedis when docker is missing.
func startACLRedis(t *testing.T) (admin, judgeC *redis.Client, addr string) {
	t.Helper()
	aclOnce.Do(func() {
		infra, err := filepath.Abs("../../../../infra/redis")
		if err != nil {
			aclErr = err
			return
		}
		out, err := exec.Command("docker", "run", "-d", "--rm", "-p", "127.0.0.1::6379",
			"-e", "REDIS_ADMIN_PASSWORD="+adminPW, "-e", "REDIS_JUDGE_PASSWORD="+judgePW, "-e", "REDIS_API_PASSWORD="+apiPW,
			"-v", filepath.Join(infra, "users.acl.tmpl")+":/etc/redis/users.acl.tmpl:ro",
			"-v", filepath.Join(infra, "entrypoint.sh")+":/entrypoint.sh:ro",
			"--entrypoint", "sh", "redis:7", "/entrypoint.sh").Output()
		if err != nil {
			aclErr = err
			return
		}
		aclID = strings.TrimSpace(string(out))
		port, err := exec.Command("docker", "port", aclID, "6379/tcp").Output()
		if err != nil {
			aclErr = err
			return
		}
		aclAddr = strings.TrimSpace(strings.Split(string(port), "\n")[0])
	})
	if aclErr != nil {
		if os.Getenv("JUDGE_REQUIRE_REDIS") == "1" {
			t.Fatalf("cannot start an ACL Redis container: %v", aclErr)
		}
		t.Skipf("cannot start an ACL Redis container: %v", aclErr)
	}
	admin = redis.NewClient(&redis.Options{Addr: aclAddr, Username: "admin", Password: adminPW})
	judgeC = redis.NewClient(&redis.Options{Addr: aclAddr, Username: "judge", Password: judgePW})
	t.Cleanup(func() { _ = admin.Close(); _ = judgeC.Close() })
	deadline := time.Now().Add(15 * time.Second)
	for admin.Ping(context.Background()).Err() != nil {
		if time.Now().After(deadline) {
			t.Fatal("ACL Redis did not come up")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := admin.FlushAll(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	return admin, judgeC, aclAddr
}

func denied(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "NOPERM") || strings.Contains(err.Error(), "no permissions"))
}

func TestJudgeACL(t *testing.T) {
	admin, judgeC, addr := startACLRedis(t)
	ctx := context.Background()
	// Real data a compromised judge would love to read or break.
	admin.Set(ctx, "tkt:secret", "ticket", 0)
	admin.Set(ctx, "rl:ip", "1", 0)
	admin.XAdd(ctx, &redis.XAddArgs{Stream: "jobs:practice", Values: map[string]any{"job": "{}"}})
	admin.XGroupCreate(ctx, "jobs:practice", Group, "0")
	admin.XAdd(ctx, &redis.XAddArgs{Stream: "results", Values: map[string]any{"result": "{}"}})
	admin.XAdd(ctx, &redis.XAddArgs{Stream: "evt:sub:1", Values: map[string]any{"event": "{}"}})
	admin.HSet(ctx, "jobs:crashes", "jobs:practice:1-0", 1)

	t.Run("Q-04: there is no way in without a user: the default user is off", func(t *testing.T) {
		anon := redis.NewClient(&redis.Options{Addr: addr})
		defer anon.Close()
		if err := anon.Ping(ctx).Err(); err == nil {
			t.Fatal("an unauthenticated client got in")
		}
		bad := redis.NewClient(&redis.Options{Addr: addr, Username: "judge", Password: "wrong"})
		defer bad.Close()
		if err := bad.Ping(ctx).Err(); err == nil {
			t.Fatal("a wrong password got in")
		}
	})

	t.Run("Q-04: the judge cannot GET, KEYS, SCAN, FLUSHALL or touch other keys", func(t *testing.T) {
		cases := map[string]func() error{
			"GET another key":           func() error { return judgeC.Get(ctx, "tkt:secret").Err() },
			"GET its own heartbeat key": func() error { return judgeC.Get(ctx, "hb:w1").Err() },
			"SET another key":           func() error { return judgeC.Set(ctx, "tkt:evil", "x", 0).Err() },
			"KEYS *":                    func() error { return judgeC.Keys(ctx, "*").Err() },
			"SCAN":                      func() error { return judgeC.Scan(ctx, 0, "*", 10).Err() },
			"FLUSHALL":                  func() error { return judgeC.FlushAll(ctx).Err() },
			"FLUSHDB":                   func() error { return judgeC.FlushDB(ctx).Err() },
			"CONFIG GET":                func() error { return judgeC.ConfigGet(ctx, "*").Err() },
			"ACL LIST":                  func() error { return judgeC.Do(ctx, "ACL", "LIST").Err() },
			"ACL SETUSER (escalation)":  func() error { return judgeC.Do(ctx, "ACL", "SETUSER", "judge", "allcommands", "allkeys").Err() },
			"SHUTDOWN":                  func() error { return judgeC.Do(ctx, "SHUTDOWN", "NOSAVE").Err() },
			"INFO":                      func() error { return judgeC.Info(ctx).Err() },
			"DEL a job stream":          func() error { return judgeC.Del(ctx, "jobs:practice").Err() },
			"DEL a heartbeat key":       func() error { return judgeC.Del(ctx, "hb:w1").Err() },
			"EVAL":                      func() error { return judgeC.Eval(ctx, "return 1", nil).Err() },
			"INJECT a job into a lane": func() error {
				return judgeC.XAdd(ctx, &redis.XAddArgs{Stream: "jobs:practice", Values: map[string]any{"job": "{}"}}).Err()
			},
			"INJECT a job into contest": func() error {
				return judgeC.XAdd(ctx, &redis.XAddArgs{Stream: "jobs:contest", Values: map[string]any{"job": "{}"}}).Err()
			},
			"XADD to a replay stream": func() error {
				return judgeC.XAdd(ctx, &redis.XAddArgs{Stream: "evt:sub:1", Values: map[string]any{"event": "{}"}}).Err()
			},
			"XADD to an arbitrary stream": func() error {
				return judgeC.XAdd(ctx, &redis.XAddArgs{Stream: "mystream", Values: map[string]any{"a": "b"}}).Err()
			},
			"READ the results stream": func() error { return judgeC.XRange(ctx, "results", "-", "+").Err() },
			"XREAD the replay streams": func() error {
				return judgeC.XRead(ctx, &redis.XReadArgs{Streams: []string{"evt:sub:1", "0"}, Block: -1}).Err()
			},
			"XDEL a result": func() error { return judgeC.XDel(ctx, "results", "0-1").Err() },
			"XREADGROUP on results": func() error {
				return judgeC.XReadGroup(ctx, &redis.XReadGroupArgs{Group: "g", Consumer: "c", Streams: []string{"results", ">"}, Block: -1}).Err()
			},
			"XGROUP CREATE on results":   func() error { return judgeC.XGroupCreate(ctx, "results", "evil", "0").Err() },
			"XGROUP DESTROY a job group": func() error { return judgeC.XGroupDestroy(ctx, "jobs:practice", Group).Err() },
			"XGROUP CREATECONSUMER":      func() error { return judgeC.Do(ctx, "XGROUP", "CREATECONSUMER", "jobs:practice", Group, "x").Err() },
			"HGETALL the crash counter":  func() error { return judgeC.HGetAll(ctx, "jobs:crashes").Err() },
			"HSET the crash counter":     func() error { return judgeC.HSet(ctx, "jobs:crashes", "x", 1).Err() },
			"HINCRBY another hash":       func() error { return judgeC.HIncrBy(ctx, "rl:ip", "x", 1).Err() },
			"PUBLISH to the SSE fan-out": func() error { return judgeC.Publish(ctx, "rt:sub:1", "{}").Err() },
			"EXISTS another key":         func() error { return judgeC.Exists(ctx, "tkt:secret").Err() },
			"EXPIRE its heartbeat":       func() error { return judgeC.Expire(ctx, "hb:w1", time.Hour).Err() },
			"TTL a ticket":               func() error { return judgeC.TTL(ctx, "tkt:secret").Err() },
			"CLIENT KILL":                func() error { return judgeC.Do(ctx, "CLIENT", "KILL", "ID", 1).Err() },
			"SELECT another database":    func() error { return judgeC.Do(ctx, "SELECT", 1).Err() },
			"PSUBSCRIBE everything":      func() error { return judgeC.Do(ctx, "PSUBSCRIBE", "*").Err() },
		}
		for name, run := range cases {
			if err := run(); !denied(err) {
				t.Errorf("%s: want a permission error, got %v", name, err)
			}
		}
		// the data is intact after all that
		if v, err := admin.Get(ctx, "tkt:secret").Result(); err != nil || v != "ticket" {
			t.Fatalf("a ticket was damaged: %q %v", v, err)
		}
		if n, _ := admin.XLen(ctx, "jobs:practice").Result(); n != 1 {
			t.Fatalf("job stream was changed: %d entries", n)
		}
	})

	t.Run("Q-04: everything the worker legitimately does is allowed", func(t *testing.T) {
		cases := map[string]func() error{
			"create a lane group": func() error { return judgeC.XGroupCreateMkStream(ctx, "jobs:rejudge", Group, "0").Err() },
			"read a lane": func() error {
				_, err := judgeC.XReadGroup(ctx, &redis.XReadGroupArgs{Group: Group, Consumer: "w", Streams: []string{"jobs:practice", ">"}, Count: 1, Block: -1}).Result()
				return err
			},
			"inspect pending": func() error {
				return judgeC.XPendingExt(ctx, &redis.XPendingExtArgs{Stream: "jobs:practice", Group: Group, Start: "-", End: "+", Count: 5}).Err()
			},
			"refresh a lease": func() error {
				return judgeC.XClaimJustID(ctx, &redis.XClaimArgs{Stream: "jobs:practice", Group: Group, Consumer: "w", MinIdle: 0, Messages: []string{"0-0"}}).Err()
			},
			"take over a job": func() error {
				return judgeC.XClaim(ctx, &redis.XClaimArgs{Stream: "jobs:practice", Group: Group, Consumer: "w", MinIdle: time.Hour, Messages: []string{"0-0"}}).Err()
			},
			"xautoclaim": func() error {
				_, _, err := judgeC.XAutoClaim(ctx, &redis.XAutoClaimArgs{Stream: "jobs:practice", Group: Group, Consumer: "w", MinIdle: time.Hour, Start: "0-0", Count: 1}).Result()
				return err
			},
			"ack and delete a job": func() error { return judgeC.XAck(ctx, "jobs:practice", Group, "0-0").Err() },
			"xdel a job":           func() error { return judgeC.XDel(ctx, "jobs:practice", "0-0").Err() },
			"dead-letter": func() error {
				return judgeC.XAdd(ctx, &redis.XAddArgs{Stream: "jobs:dlq", Values: map[string]any{"job": "{}"}}).Err()
			},
			"quarantine": func() error {
				return judgeC.XAdd(ctx, &redis.XAddArgs{Stream: "jobs:quarantine", Values: map[string]any{"job": "{}"}}).Err()
			},
			"count a crash":       func() error { return judgeC.HIncrBy(ctx, "jobs:crashes", "jobs:practice:9-0", 1).Err() },
			"read a crash count":  func() error { _, err := judgeC.HGet(ctx, "jobs:crashes", "jobs:practice:9-0").Result(); return err },
			"clear a crash count": func() error { return judgeC.HDel(ctx, "jobs:crashes", "jobs:practice:9-0").Err() },
			"publish a result": func() error {
				return judgeC.XAdd(ctx, &redis.XAddArgs{Stream: "results", Values: map[string]any{"result": "{}"}}).Err()
			},
			"publish progress":  func() error { return judgeC.Publish(ctx, "progress:sub-1", "{}").Err() },
			"set a heartbeat":   func() error { return judgeC.Set(ctx, "hb:w1", "{}", 10*time.Second).Err() },
			"check a heartbeat": func() error { return judgeC.Exists(ctx, "hb:w1").Err() },
			"commit in a transaction": func() error {
				_, err := judgeC.TxPipelined(ctx, func(p redis.Pipeliner) error {
					p.XAdd(ctx, &redis.XAddArgs{Stream: "results", Values: map[string]any{"result": "{}"}})
					p.XAck(ctx, "jobs:practice", Group, "0-0")
					p.XDel(ctx, "jobs:practice", "0-0")
					p.HDel(ctx, "jobs:crashes", "x")
					return nil
				})
				return err
			},
		}
		for name, run := range cases {
			if err := run(); denied(err) {
				t.Errorf("%s was denied: %v", name, err)
			}
		}
	})
}

// lockedBuffer collects the worker's log so a test can prove no Redis command was refused.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuffer) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

func TestWorkerRunsUnderTheJudgeACL(t *testing.T) {
	admin, judgeC, _ := startACLRedis(t)
	ctx := context.Background()
	stream := JobsKey(contracts.LanePractice)
	var logs lockedBuffer
	withLog := func(c *Config) { c.Log = slog.New(slog.NewTextHandler(&logs, nil)); fast(c) }
	noPerm := func() {
		t.Helper()
		if out := logs.String(); strings.Contains(out, "NOPERM") || strings.Contains(out, "no permissions") {
			t.Fatalf("the ACL refused a command the worker needs:\n%s", out)
		}
	}

	t.Run("Q-04: a job goes through as the judge user: claim, progress, heartbeat, result, ack", func(t *testing.T) {
		sub := admin.Subscribe(ctx, ProgressChannel("sub-1"))
		defer sub.Close()
		if _, err := sub.Receive(ctx); err != nil {
			t.Fatal(err)
		}
		ex := &fakeExec{}
		start(t, judgeC, ex, withLog)
		enqueue(t, admin, validJob("1"))
		waitFor(t, "result", func() bool { return streamLen(admin, ResultsKey) == 1 })
		waitFor(t, "ack", func() bool { return pending(admin, stream) == 0 })
		waitFor(t, "heartbeat", func() bool { return admin.Exists(ctx, HeartbeatKey("w1")).Val() == 1 })
		select {
		case m := <-sub.Channel():
			if !strings.Contains(m.Payload, "sub-1") {
				t.Fatalf("%s", m.Payload)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("no progress event reached the subscriber")
		}
		if streamLen(admin, stream) != 0 {
			t.Fatal("the job entry was not deleted")
		}
		noPerm()
	})

	t.Run("Q-04: leases, takeover, quarantine and the dead-letter paths all work under the ACL", func(t *testing.T) {
		admin.FlushAll(ctx)
		// A ghost holds a job that already crashed one worker: set it up before the worker starts,
		// so the worker cannot take it first.
		enqueue(t, admin, validJob("haunted"))
		id := ghostTake(t, admin, "ghost")
		admin.HSet(ctx, CrashesKey, stream+":"+id, 1)

		ex := &fakeExec{started: make(chan string, 4), release: make(chan struct{})}
		start(t, judgeC, ex, withLog)
		waitFor(t, "quarantine", func() bool { return streamLen(admin, QuarantineKey) == 1 })

		// a slow job keeps its lease for more than twice the reclaim limit
		slowID := enqueue(t, admin, validJob("slow"))
		select {
		case <-ex.started:
		case <-time.After(10 * time.Second):
			t.Fatalf("the worker never started the job; log:\n%s", logs.String())
		}
		time.Sleep(900 * time.Millisecond)
		if p := pendingInfo(t, admin, stream, slowID); p.Consumer != "w1" || p.RetryCount != 1 {
			t.Fatalf("lease not kept under the ACL: owner=%s deliveries=%d", p.Consumer, p.RetryCount)
		}
		close(ex.release)
		waitFor(t, "slow result", func() bool { return streamLen(admin, ResultsKey) == 2 }) // SE for the quarantined job + the slow one

		// an unparseable job is dead-lettered
		admin.XAdd(ctx, &redis.XAddArgs{Stream: stream, Values: map[string]any{FieldJob: `{"jobId":"x"}`}})
		waitFor(t, "dead letter", func() bool { return streamLen(admin, DLQKey) == 1 })
		waitFor(t, "all acknowledged", func() bool { return pending(admin, stream) == 0 })
		noPerm()
	})

	t.Run("Q-04: the judge user as loaded has no broad grants (no all-commands, all-keys, GET, KEYS, FLUSHALL, EVAL, CONFIG, ACL)", func(t *testing.T) {
		got, err := admin.Do(ctx, "ACL", "GETUSER", "judge").Result()
		if err != nil {
			t.Fatal(err)
		}
		s := strings.ToLower(strings.ReplaceAll(strings.Join(strings.Fields(strings.TrimSpace(toString(got))), " "), "\n", " "))
		for _, forbidden := range []string{"+@all", "allkeys", "allchannels", "+get ", "+keys", "+flushall", "+eval", "+config", "+acl"} {
			if strings.Contains(s, forbidden) {
				t.Errorf("the judge ACL contains %q: %s", forbidden, s)
			}
		}
	})
}

func toString(v any) string { return fmt.Sprint(v) }
