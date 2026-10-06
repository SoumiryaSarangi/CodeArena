package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

// settings are the worker's environment variables. Blank values count as
// unset, like the API's config, so `KEY=` in a .env file means "use the default".
type settings struct {
	RedisURL    string
	S3Endpoint  string
	S3Bucket    string
	S3AccessKey string
	S3SecretKey string
	WorkerID    string
	Lanes       []contracts.Lane
	Concurrency int
	CacheDir    string
	BoxIDBase   int
	Cores       []int
	// Lease timings (Q-02). Zero means the worker defaults (2 s / 10 s).
	LeaseEvery  time.Duration
	ReclaimIdle time.Duration
}

func loadSettings(get func(string) string) (settings, error) {
	val := func(k string) string { return strings.TrimSpace(get(k)) }
	s := settings{
		RedisURL: val("REDIS_URL"), S3Endpoint: val("S3_ENDPOINT"), S3Bucket: val("S3_BUCKET"),
		S3AccessKey: val("S3_ACCESS_KEY"), S3SecretKey: val("S3_SECRET_KEY"),
		WorkerID: val("WORKER_ID"), Lanes: []contracts.Lane{contracts.LanePractice}, Concurrency: 1, BoxIDBase: 100,
	}
	var errs []error
	for k, v := range map[string]string{"REDIS_URL": s.RedisURL, "S3_ENDPOINT": s.S3Endpoint, "S3_BUCKET": s.S3Bucket,
		"S3_ACCESS_KEY": s.S3AccessKey, "S3_SECRET_KEY": s.S3SecretKey} {
		if v == "" {
			errs = append(errs, fmt.Errorf("%s is required", k))
		}
	}
	if v := val("WORKER_LANES"); v != "" {
		s.Lanes = nil
		seen := map[contracts.Lane]bool{}
		for _, p := range strings.Split(v, ",") {
			l := contracts.Lane(strings.TrimSpace(p))
			switch l {
			case contracts.LaneContest, contracts.LaneInteractive, contracts.LanePractice, contracts.LaneRejudge:
			default:
				errs = append(errs, fmt.Errorf("WORKER_LANES has %q, which is not a lane (contest, interactive, practice, rejudge)", p))
				continue
			}
			if seen[l] {
				errs = append(errs, fmt.Errorf("WORKER_LANES lists %q twice", l))
				continue
			}
			seen[l] = true
			s.Lanes = append(s.Lanes, l)
		}
	}
	if v := val("WORKER_CONCURRENCY"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 64 {
			errs = append(errs, fmt.Errorf("WORKER_CONCURRENCY must be 1-64, got %q", v))
		}
		s.Concurrency = n
	}
	if v := val("WORKER_BOX_BASE"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 900 {
			errs = append(errs, fmt.Errorf("WORKER_BOX_BASE must be 0-900, got %q", v))
		}
		s.BoxIDBase = n
	}
	if v := val("WORKER_CORES"); v != "" {
		for _, p := range strings.Split(v, ",") {
			n, err := strconv.Atoi(strings.TrimSpace(p))
			if err != nil || n < 0 {
				errs = append(errs, fmt.Errorf("WORKER_CORES must be a comma list of core numbers, got %q", v))
				break
			}
			s.Cores = append(s.Cores, n)
		}
	}
	for key, dst := range map[string]*time.Duration{"WORKER_LEASE_MS": &s.LeaseEvery, "WORKER_RECLAIM_IDLE_MS": &s.ReclaimIdle} {
		if v := val(key); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 50 || n > 600000 {
				errs = append(errs, fmt.Errorf("%s must be 50-600000 milliseconds, got %q", key, v))
				continue
			}
			*dst = time.Duration(n) * time.Millisecond
		}
	}
	if len(s.Cores) == 0 {
		for i := 0; i < s.Concurrency; i++ {
			s.Cores = append(s.Cores, i) // one slot per concurrent job, one core each
		}
	}
	if len(s.Cores) != s.Concurrency {
		errs = append(errs, fmt.Errorf("WORKER_CORES lists %d cores but WORKER_CONCURRENCY is %d: one core per concurrent job", len(s.Cores), s.Concurrency))
	}
	if s.CacheDir = val("WORKER_CACHE_DIR"); s.CacheDir == "" {
		base, err := os.UserCacheDir()
		if err != nil {
			errs = append(errs, fmt.Errorf("no WORKER_CACHE_DIR and no user cache dir: %w", err))
		}
		s.CacheDir = filepath.Join(base, "codearena", "tests")
	}
	return s, errors.Join(errs...)
}

// rootGuard refuses to run the worker as root (J-08). The worker parses job
// data and drives the sandbox; if a submission ever escaped a box into the
// worker's process, it must not gain root. isolate is setuid, so the worker
// never needs root itself. WORKER_ALLOW_ROOT=1 overrides it, deliberately
// loudly, for a throwaway machine.
func rootGuard(euid int, get func(string) string) error {
	if euid != 0 {
		return nil
	}
	if strings.TrimSpace(get("WORKER_ALLOW_ROOT")) == "1" {
		return nil
	}
	return errors.New("refusing to run as root: run the worker as an unprivileged user (on the judge VM, codearena-judge); set WORKER_ALLOW_ROOT=1 only on a throwaway machine")
}
