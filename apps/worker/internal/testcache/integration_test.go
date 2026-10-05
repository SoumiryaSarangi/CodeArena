package testcache

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// countingStore wraps a real store and counts Opens.
type countingStore struct {
	Store
	opens atomic.Int64
}

func (s *countingStore) Open(ctx context.Context, bucket, key string) (io.ReadCloser, int64, error) {
	s.opens.Add(1)
	return s.Store.Open(ctx, bucket, key)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// TestIntegration uses the dev object store from infra compose (SeaweedFS on
// :8333). Defaults are the compose dev credentials; S3_ENDPOINT, S3_BUCKET,
// S3_ACCESS_KEY and S3_SECRET_KEY override them. It skips when the store is
// not reachable; JUDGE_REQUIRE_S3=1 turns the skip into a failure.
func TestIntegration(t *testing.T) {
	endpoint := envOr("S3_ENDPOINT", "http://localhost:8333")
	bucket := envOr("S3_BUCKET", "codearena")
	ak, sk := envOr("S3_ACCESS_KEY", "codearena"), envOr("S3_SECRET_KEY", "codearena-dev")
	skip := func(format string, args ...any) {
		t.Helper()
		if os.Getenv("JUDGE_REQUIRE_S3") == "1" {
			t.Fatalf(format, args...)
		}
		t.Skipf(format, args...)
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if conn, err := net.DialTimeout("tcp", u.Host, time.Second); err != nil {
		skip("object store not reachable at %s: %v", endpoint, err)
	} else {
		_ = conn.Close()
	}

	ctx := context.Background()
	// A writer client, only to put the fixture; the cache itself only reads.
	w, err := minio.New(u.Host, &minio.Options{Creds: credentials.NewStaticV4(ak, sk, ""), Secure: u.Scheme == "https", BucketLookup: minio.BucketLookupPath})
	if err != nil {
		t.Fatal(err)
	}
	data := buildTar(t, append(pair(1, "1 2\n", "3\n"), pair(2, "5 5\n", "10\n")...)...)
	key := fmt.Sprintf("testsets/j04-%d.tar", time.Now().UnixNano())
	if _, err := w.PutObject(ctx, bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{}); err != nil {
		skip("cannot write the fixture to %s/%s: %v", endpoint, bucket, err)
	}
	t.Cleanup(func() { _ = w.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{}) })

	real, err := NewS3(S3Config{Endpoint: endpoint, AccessKey: ak, SecretKey: sk})
	if err != nil {
		t.Fatal(err)
	}
	store := &countingStore{Store: real}
	c, err := New(Config{Root: tempRoot(t), Store: store, Bucket: bucket})
	if err != nil {
		t.Fatal(err)
	}
	hash, uri := hashOf(data), fmt.Sprintf("s3://%s/%s", bucket, key)

	t.Run("J-04 accept: the second run of the same testset does not hit object storage", func(t *testing.T) {
		for i := 0; i < 2; i++ {
			ts, err := c.Get(ctx, hash, uri)
			if err != nil {
				t.Fatal(err)
			}
			in, ans, err := ts.Load(2)
			if err != nil || string(in) != "5 5\n" || string(ans) != "10\n" {
				t.Fatalf("%q %q %v", in, ans, err)
			}
			ts.Release()
		}
		if n := store.opens.Load(); n != 1 {
			t.Fatalf("object store opened %d times, want 1", n)
		}
	})
	t.Run("FR-JUDGE-12: a wrong hash against the real store is refused", func(t *testing.T) {
		other := hashOf([]byte("not this archive"))
		if _, err := c.Get(ctx, other, uri); !errors.Is(err, ErrHashMismatch) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a key that does not exist is ErrNotFound", func(t *testing.T) {
		missing := fmt.Sprintf("s3://%s/testsets/does-not-exist-%d.tar", bucket, time.Now().UnixNano())
		if _, err := c.Get(ctx, hashOf([]byte("x")), missing); !errors.Is(err, ErrNotFound) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a bad endpoint is rejected up front", func(t *testing.T) {
		for _, e := range []string{"", "localhost:8333", "ftp://x", "http://"} {
			if _, err := NewS3(S3Config{Endpoint: e}); err == nil {
				t.Fatalf("accepted %q", e)
			}
		}
	})
}
