package main

import (
	"strings"
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

var required = map[string]string{
	"REDIS_URL": "redis://localhost:6379", "S3_ENDPOINT": "http://localhost:8333", "S3_BUCKET": "codearena",
	"S3_ACCESS_KEY": "a", "S3_SECRET_KEY": "b",
}

func with(extra map[string]string) map[string]string {
	m := map[string]string{}
	for k, v := range required {
		m[k] = v
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestLoadSettings(t *testing.T) {
	t.Run("defaults: practice lane, one slot on core 0, box base 100", func(t *testing.T) {
		s, err := loadSettings(env(required))
		if err != nil {
			t.Fatal(err)
		}
		if s.Lane != contracts.LanePractice || s.Concurrency != 1 || len(s.Cores) != 1 || s.Cores[0] != 0 || s.BoxIDBase != 100 {
			t.Fatalf("%+v", s)
		}
		if !strings.HasSuffix(s.CacheDir, "codearena/tests") {
			t.Fatalf("cache dir %q", s.CacheDir)
		}
	})
	t.Run("blank values mean unset", func(t *testing.T) {
		s, err := loadSettings(env(with(map[string]string{"WORKER_LANE": "  ", "WORKER_CONCURRENCY": "", "WORKER_CORES": ""})))
		if err != nil || s.Concurrency != 1 || s.Lane != contracts.LanePractice {
			t.Fatalf("%+v %v", s, err)
		}
	})
	t.Run("concurrency picks one core per job", func(t *testing.T) {
		s, err := loadSettings(env(with(map[string]string{"WORKER_CONCURRENCY": "3"})))
		if err != nil || len(s.Cores) != 3 || s.Cores[2] != 2 {
			t.Fatalf("%+v %v", s, err)
		}
		s, err = loadSettings(env(with(map[string]string{"WORKER_CONCURRENCY": "2", "WORKER_CORES": "4, 6"})))
		if err != nil || s.Cores[0] != 4 || s.Cores[1] != 6 {
			t.Fatalf("%+v %v", s, err)
		}
	})
	t.Run("missing required settings are all reported, without echoing secrets", func(t *testing.T) {
		_, err := loadSettings(env(map[string]string{"S3_SECRET_KEY": "hunter2"}))
		if err == nil {
			t.Fatal("expected an error")
		}
		for _, k := range []string{"REDIS_URL", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY"} {
			if !strings.Contains(err.Error(), k) {
				t.Fatalf("%s not reported: %v", k, err)
			}
		}
		if strings.Contains(err.Error(), "hunter2") {
			t.Fatal("a secret leaked into the error")
		}
	})
	t.Run("bad values are rejected", func(t *testing.T) {
		for _, extra := range []map[string]string{
			{"WORKER_LANE": "vip"}, {"WORKER_CONCURRENCY": "0"}, {"WORKER_CONCURRENCY": "x"}, {"WORKER_CONCURRENCY": "65"},
			{"WORKER_BOX_BASE": "-1"}, {"WORKER_BOX_BASE": "901"}, {"WORKER_CORES": "a"}, {"WORKER_CORES": "-1"},
			{"WORKER_CORES": "1,2", "WORKER_CONCURRENCY": "1"},
		} {
			if _, err := loadSettings(env(with(extra))); err == nil {
				t.Fatalf("accepted %v", extra)
			}
		}
	})
}

func TestRootGuard(t *testing.T) {
	t.Run("J-08: an unprivileged worker starts", func(t *testing.T) {
		if err := rootGuard(1000, env(nil)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("J-08: the worker refuses to run as root", func(t *testing.T) {
		err := rootGuard(0, env(nil))
		if err == nil || !strings.Contains(err.Error(), "refusing to run as root") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("WORKER_ALLOW_ROOT=1 overrides, anything else does not", func(t *testing.T) {
		if err := rootGuard(0, env(map[string]string{"WORKER_ALLOW_ROOT": "1"})); err != nil {
			t.Fatal(err)
		}
		for _, v := range []string{"", "0", "true", "yes"} {
			if rootGuard(0, env(map[string]string{"WORKER_ALLOW_ROOT": v})) == nil {
				t.Fatalf("%q overrode the guard", v)
			}
		}
	})
}
