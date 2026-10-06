// Command worker is the judge: it pulls jobs from Redis, runs them in isolate
// boxes and publishes verdicts. It holds no database credentials (FR-JUDGE-09).
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/languages"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/telemetry"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/testcache"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/worker"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("worker stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	if err := rootGuard(os.Geteuid(), os.Getenv); err != nil {
		return err
	}
	cfg, err := loadSettings(os.Getenv)
	if err != nil {
		return err
	}
	// SIGINT/SIGTERM stop claiming; running jobs finish. A second signal kills.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { <-ctx.Done(); stop() }()

	if cfg.WorkerID == "" {
		h, _ := os.Hostname()
		cfg.WorkerID = h
	}
	shutdownOTel, err := telemetry.Setup(ctx, "codearena-worker", cfg.WorkerID)
	if err != nil {
		return err
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownOTel(c)
	}()

	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return err // the URL is not echoed: it may hold a password
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()

	store, err := testcache.NewS3(testcache.S3Config{Endpoint: cfg.S3Endpoint, AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey})
	if err != nil {
		return err
	}
	cache, err := testcache.New(testcache.Config{Root: cfg.CacheDir, Store: store, Bucket: cfg.S3Bucket})
	if err != nil {
		return err
	}
	reg, err := languages.Default()
	if err != nil {
		return err
	}
	pool, err := sandbox.New(ctx, sandbox.Config{Cores: cfg.Cores, BoxIDBase: cfg.BoxIDBase})
	if err != nil {
		return err
	}
	defer func() { _ = pool.Close(context.Background()) }()

	w, err := worker.New(worker.Config{
		Redis: rdb, Lanes: cfg.Lanes, LeaseEvery: cfg.LeaseEvery, ReclaimIdle: cfg.ReclaimIdle, WorkerID: cfg.WorkerID, Concurrency: cfg.Concurrency, Log: log,
		Exec: &worker.Runner{Pool: pool, Cache: cache, Store: store, Bucket: cfg.S3Bucket, Engine: &judge.Engine{Reg: reg}},
	})
	if err != nil {
		return err
	}
	log.Info("worker started", "id", cfg.WorkerID, "lanes", cfg.Lanes, "concurrency", cfg.Concurrency, "cores", cfg.Cores)
	err = w.Run(ctx)
	log.Info("worker drained, exiting")
	return err
}
