package worker

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// The worker tests talk to a throwaway Redis container (never the dev Redis,
// whose streams hold real jobs). docker must be available; without it the
// tests skip, or fail when JUDGE_REQUIRE_REDIS=1 (CI).
var (
	redisOnce sync.Once
	redisAddr string
	redisID   string
	redisErr  error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if redisID != "" {
		_ = exec.Command("docker", "rm", "-f", redisID).Run()
	}
	os.Exit(code)
}

func startRedis(t *testing.T) *redis.Client {
	t.Helper()
	redisOnce.Do(func() {
		out, err := exec.Command("docker", "run", "-d", "--rm", "-p", "127.0.0.1::6379", "redis:7").Output()
		if err != nil {
			redisErr = err
			return
		}
		redisID = strings.TrimSpace(string(out))
		port, err := exec.Command("docker", "port", redisID, "6379/tcp").Output()
		if err != nil {
			redisErr = err
			return
		}
		redisAddr = strings.TrimSpace(strings.Split(string(port), "\n")[0])
	})
	if redisErr != nil {
		if os.Getenv("JUDGE_REQUIRE_REDIS") == "1" {
			t.Fatalf("cannot start a Redis container: %v", redisErr)
		}
		t.Skipf("cannot start a Redis container: %v", redisErr)
	}
	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	t.Cleanup(func() { _ = rdb.Close() })
	deadline := time.Now().Add(15 * time.Second)
	for rdb.Ping(context.Background()).Err() != nil {
		if time.Now().After(deadline) {
			t.Fatal("Redis did not come up")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := rdb.FlushAll(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	return rdb
}
