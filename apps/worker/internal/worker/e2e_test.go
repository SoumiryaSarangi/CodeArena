package worker

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/languages"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/testcache"
)

// memStore is an in-memory object store that counts Opens per key.
type memStore struct {
	objects map[string][]byte
	opens   map[string]*atomic.Int64
}

func (s *memStore) Open(_ context.Context, bucket, key string) (io.ReadCloser, int64, error) {
	data, ok := s.objects[key]
	if bucket != "codearena" || !ok {
		return nil, 0, fmt.Errorf("%w: %s/%s", testcache.ErrNotFound, bucket, key)
	}
	s.opens[key].Add(1)
	return io.NopCloser(bytes.NewReader(data)), int64(len(data)), nil
}

func tarOf(t *testing.T, files map[string]string, order ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, n := range order {
		_ = tw.WriteHeader(&tar.Header{Name: n, Mode: 0o644, Size: int64(len(files[n])), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(files[n]))
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const (
	sumC  = `#include <stdio.h>` + "\n" + `int main(){long a,b;scanf("%ld %ld",&a,&b);printf("%ld\n",a+b);return 0;}`
	wrong = `#include <stdio.h>` + "\n" + `int main(){long a,b;scanf("%ld %ld",&a,&b);printf("%ld\n",a+b+1);return 0;}`
)

// TestEndToEnd drives the real thing: Redis stream -> worker -> testset cache
// -> compile and run in isolate boxes -> checker -> results stream.
func TestEndToEnd(t *testing.T) {
	rdb := startRedis(t)
	for _, bin := range []string{"isolate", "taskset"} {
		if _, err := exec.LookPath(bin); err != nil {
			if os.Getenv("JUDGE_REQUIRE_ISOLATE") == "1" {
				t.Fatalf("%s not installed", bin)
			}
			t.Skipf("%s not installed", bin)
		}
	}
	ctx := context.Background()

	data := tarOf(t, map[string]string{"01.in": "1 2\n", "01.ans": "3\n", "02.in": "5 5\n", "02.ans": "10\n"}, "01.in", "01.ans", "02.in", "02.ans")
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	ncmp, err := os.ReadFile("../judge/testdata/chk_ncmp.cpp")
	if err != nil {
		t.Fatal(err)
	}
	broken, err := os.ReadFile("../judge/testdata/chk_broken.cpp")
	if err != nil {
		t.Fatal(err)
	}
	store := &memStore{
		objects: map[string][]byte{"testsets/sum.tar": data, "checkers/ncmp.cpp": ncmp, "checkers/broken.cpp": broken},
		opens:   map[string]*atomic.Int64{"testsets/sum.tar": {}, "checkers/ncmp.cpp": {}, "checkers/broken.cpp": {}},
	}

	root := t.TempDir() + "/tests"
	t.Cleanup(func() { // cached testsets are read-only (0550); make them removable
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				_ = os.Chmod(p, 0o750)
			}
			return nil
		})
	})
	cache, err := testcache.New(testcache.Config{Root: root, Store: store, Bucket: "codearena"})
	if err != nil {
		t.Fatal(err)
	}
	reg, err := languages.Default()
	if err != nil {
		t.Fatal(err)
	}
	// Box ids 980+ keep clear of the other packages' tests.
	pool, err := sandbox.New(ctx, sandbox.Config{Cores: []int{min(4, runtime.NumCPU()-1)}, BoxIDBase: 980})
	if err != nil {
		t.Skipf("isolate unusable: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close(ctx) })
	runner := &Runner{Pool: pool, Cache: cache, Store: store, Bucket: "codearena", Engine: &judge.Engine{Reg: reg}}
	start(t, rdb, runner, func(c *Config) { c.RetryBackoff = 0 })

	job := func(id, src string, checker contracts.Checker) contracts.JudgeJob {
		j := validJob(id)
		j.Source = src
		j.Problem.TestsetHash = hash
		j.Problem.TestsetURI = "s3://codearena/testsets/sum.tar"
		j.Problem.Checker = checker
		return j
	}
	tokens := contracts.Checker{Kind: contracts.CheckerKindTokens}
	uri := func(k string) *string { s := "s3://codearena/checkers/" + k; return &s }
	testlib := func(k string) contracts.Checker {
		return contracts.Checker{Kind: contracts.CheckerKindTestlib, SourceURI: uri(k)}
	}
	custom := job("custom", sumC, tokens)
	custom.Mode = contracts.JobModeRun
	in := "1 2\n"
	custom.CustomInput = &in

	cases := []struct {
		id      string
		j       contracts.JudgeJob
		verdict contracts.Verdict
	}{
		{"ac", job("ac", sumC, tokens), contracts.VerdictAC},
		{"wa", job("wa", wrong, tokens), contracts.VerdictWA},
		{"ce", job("ce", "int main( {", tokens), contracts.VerdictCE},
		{"tl-ac", job("tl-ac", sumC, testlib("ncmp.cpp")), contracts.VerdictAC},
		{"tl-wa", job("tl-wa", wrong, testlib("ncmp.cpp")), contracts.VerdictWA},
		{"jury", job("jury", sumC, testlib("broken.cpp")), contracts.VerdictSE},
		{"custom", custom, contracts.VerdictAC},
	}
	for _, c := range cases {
		enqueue(t, rdb, c.j)
	}
	waitFor(t, "all results", func() bool { return streamLen(rdb, ResultsKey) == int64(len(cases)) })

	got := map[string]contracts.JudgeResult{}
	for _, r := range results(t, rdb) {
		got[r.SubmissionID] = r
	}
	for _, c := range cases {
		t.Run("J-05 accept: "+c.id+" -> "+string(c.verdict), func(t *testing.T) {
			r, ok := got["sub-"+c.id]
			if !ok || r.Verdict != c.verdict || r.RunVersion != 1 {
				t.Fatalf("%+v", r)
			}
		})
	}
	t.Run("AC carries per-test outcomes with time and memory", func(t *testing.T) {
		r := got["sub-ac"]
		if len(r.Tests) != 2 || r.Tests[0].No != 1 || r.Tests[1].No != 2 || r.MemKB <= 0 {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("WA stops at the first failing test (stopOnFirstFailure)", func(t *testing.T) {
		r := got["sub-wa"]
		if len(r.Tests) != 1 || r.Tests[0].CheckerMsg == nil {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("CE carries the compiler log", func(t *testing.T) {
		if r := got["sub-ce"]; r.CompileLog == nil || *r.CompileLog == "" || len(r.Tests) != 0 {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("J-04 + J-05: the six problem jobs fetched the testset once", func(t *testing.T) {
		if n := store.opens["testsets/sum.tar"].Load(); n != 1 {
			t.Fatalf("testset downloaded %d times", n)
		}
	})
	t.Run("the testlib checker is compiled once per problem version", func(t *testing.T) {
		if n := store.opens["checkers/ncmp.cpp"].Load(); n != 1 {
			t.Fatalf("checker source fetched %d times", n)
		}
	})
	t.Run("FR-SUB-05: a custom run returns stdout and stderr, and problem tests never do", func(t *testing.T) {
		r := got["sub-custom"]
		if r.Output == nil || *r.Output != "3\n" || r.Stderr == nil || *r.Stderr != "" || len(r.Tests) != 1 {
			t.Fatalf("%+v", r)
		}
		for _, id := range []string{"ac", "wa", "ce", "tl-ac", "tl-wa", "jury"} {
			if got["sub-"+id].Output != nil || got["sub-"+id].Stderr != nil {
				t.Fatalf("%s leaked program output", id)
			}
		}
	})
	t.Run("FR-JUDGE-06: a broken checker publishes SE without dead-lettering", func(t *testing.T) {
		if n := streamLen(rdb, DLQKey); n != 0 {
			t.Fatalf("dlq has %d entries, want 0", n)
		}
	})
	waitFor(t, "ack", func() bool { return pending(rdb, "jobs:practice") == 0 })
}
