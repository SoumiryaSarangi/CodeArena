package testcache

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type member struct {
	name string
	body string
	typ  byte
	link string
}

func buildTar(t *testing.T, ms ...member) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, m := range ms {
		typ := m.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		h := &tar.Header{Name: m.name, Typeflag: typ, Mode: 0o644, Linkname: m.link}
		if typ == tar.TypeReg {
			h.Size = int64(len(m.body))
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			if _, err := tw.Write([]byte(m.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func hashOf(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func pair(n int, in, ans string) []member {
	return []member{{name: fmt.Sprintf("%02d.in", n), body: in}, {name: fmt.Sprintf("%02d.ans", n), body: ans}}
}

// fakeStore serves objects from memory and counts Opens.
type fakeStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	opens   atomic.Int64
	fail    error
	delay   time.Duration
	size    *int64 // lie about the size
}

func newFakeStore() *fakeStore { return &fakeStore{objects: map[string][]byte{}} }

func (s *fakeStore) put(key string, data []byte) { s.mu.Lock(); s.objects[key] = data; s.mu.Unlock() }

func (s *fakeStore) Open(ctx context.Context, bucket, key string) (io.ReadCloser, int64, error) {
	s.opens.Add(1)
	if s.delay > 0 {
		time.Sleep(s.delay)
	}
	if s.fail != nil {
		return nil, 0, s.fail
	}
	s.mu.Lock()
	data, ok := s.objects[key]
	s.mu.Unlock()
	if bucket != "codearena" || !ok {
		return nil, 0, fmt.Errorf("%w: %s/%s", ErrNotFound, bucket, key)
	}
	size := int64(len(data))
	if s.size != nil {
		size = *s.size
	}
	return io.NopCloser(bytes.NewReader(data)), size, nil
}

// tempRoot is a cache root that is removable at test end: cached directories
// are read-only (0550), which t.TempDir's own cleanup cannot delete.
func tempRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "tests")
	t.Cleanup(func() { _ = removeAll(root) })
	return root
}

func newCache(t *testing.T, st Store, max int64) *Cache {
	t.Helper()
	c, err := New(Config{Root: tempRoot(t), MaxBytes: max, Store: st, Bucket: "codearena"})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func uri(key string) string { return "s3://codearena/testsets/" + key }

// seed stores a testset and returns its hash and URI.
func seed(t *testing.T, st *fakeStore, name string, ms ...member) (string, string) {
	t.Helper()
	data := buildTar(t, ms...)
	st.put("testsets/"+name, data)
	return hashOf(data), uri(name)
}

func TestSecondRunDoesNotHitTheStore(t *testing.T) {
	t.Run("J-04 accept / FR-JUDGE-12: the second run of the same testset does not touch object storage", func(t *testing.T) {
		st := newFakeStore()
		hash, u := seed(t, st, "a.tar", append(pair(1, "1 2\n", "3\n"), pair(2, "5 5\n", "10\n")...)...)
		c := newCache(t, st, 0)
		for i := 0; i < 3; i++ {
			ts, err := c.Get(context.Background(), hash, u)
			if err != nil {
				t.Fatal(err)
			}
			in, ans, err := ts.Load(2)
			if err != nil || string(in) != "5 5\n" || string(ans) != "10\n" {
				t.Fatalf("%q %q %v", in, ans, err)
			}
			ts.Release()
		}
		if n := st.opens.Load(); n != 1 {
			t.Fatalf("store opened %d times, want 1", n)
		}
		if s := c.Stats(); s.Hits != 2 || s.Misses != 1 || s.Downloads != 1 {
			t.Fatalf("%+v", s)
		}
	})
}

func TestIntegrityAndInput(t *testing.T) {
	ctx := context.Background()
	t.Run("FR-JUDGE-12: a wrong hash is refused and nothing is stored", func(t *testing.T) {
		st := newFakeStore()
		_, u := seed(t, st, "a.tar", pair(1, "x", "y")...)
		c := newCache(t, st, 0)
		wrong := hashOf([]byte("something else"))
		if _, err := c.Get(ctx, wrong, u); !errors.Is(err, ErrHashMismatch) {
			t.Fatalf("got %v", err)
		}
		if _, err := os.Stat(filepath.Join(c.cfg.Root, wrong)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("a mismatched testset was stored: %v", err)
		}
		if c.Size() != 0 || c.Stats().Failures != 1 {
			t.Fatalf("size %d stats %+v", c.Size(), c.Stats())
		}
		if left, _ := os.ReadDir(c.tmp); len(left) != 0 {
			t.Fatalf("temp files left: %v", left)
		}
	})
	t.Run("FR-JUDGE-12: a failed download is not cached; a later retry works", func(t *testing.T) {
		st := newFakeStore()
		hash, u := seed(t, st, "a.tar", pair(1, "x", "y")...)
		c := newCache(t, st, 0)
		st.fail = errors.New("connection reset")
		if _, err := c.Get(ctx, hash, u); err == nil {
			t.Fatal("expected an error")
		}
		st.fail = nil
		ts, err := c.Get(ctx, hash, u)
		if err != nil {
			t.Fatal(err)
		}
		ts.Release()
	})
	t.Run("a missing object is ErrNotFound", func(t *testing.T) {
		c := newCache(t, newFakeStore(), 0)
		if _, err := c.Get(ctx, hashOf([]byte("x")), uri("nope.tar")); !errors.Is(err, ErrNotFound) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("an archive larger than the cap is refused before download", func(t *testing.T) {
		st := newFakeStore()
		hash, u := seed(t, st, "a.tar", pair(1, "x", "y")...)
		huge := int64(MaxTarBytes + 1)
		st.size = &huge
		if _, err := newCache(t, st, 0).Get(ctx, hash, u); !errors.Is(err, ErrTooLarge) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("bad hashes are refused", func(t *testing.T) {
		c := newCache(t, newFakeStore(), 0)
		for _, h := range []string{"", "abc", "../../etc", hashOf(nil)[:63], "G" + hashOf(nil)[1:], "A" + hashOf(nil)[1:]} {
			if _, err := c.Get(ctx, h, uri("a.tar")); !errors.Is(err, ErrBadHash) {
				t.Fatalf("%q: got %v", h, err)
			}
		}
	})
	t.Run("FR-JUDGE-09: URIs may only name the configured bucket and the testsets prefix", func(t *testing.T) {
		st := newFakeStore()
		hash, _ := seed(t, st, "a.tar", pair(1, "x", "y")...)
		c := newCache(t, st, 0)
		for _, u := range []string{
			"s3://other/testsets/a.tar", "http://codearena/testsets/a.tar", "s3://codearena/private/a.tar",
			"s3://codearena/testsets/../private/a.tar", "s3://codearena/testsets/a.tar?versionId=1", "s3://codearena/testsets/a.tar#x",
			"s3://codearena/testsets//a.tar", "s3://codearena/", "", "file:///etc/passwd", "s3://codearena/testsets/./a.tar",
		} {
			if _, err := c.Get(ctx, hash, u); !errors.Is(err, ErrBadURI) {
				t.Fatalf("%q: got %v", u, err)
			}
		}
		if st.opens.Load() != 0 {
			t.Fatal("the store was contacted for a bad URI")
		}
	})
}

func TestArchiveRejection(t *testing.T) {
	ctx := context.Background()
	bad := map[string][]member{
		"symlink":            {{name: "01.in", typ: tar.TypeSymlink, link: "/etc/passwd"}, {name: "01.ans", body: "x"}},
		"hard link":          {{name: "01.in", body: "x"}, {name: "01.ans", typ: tar.TypeLink, link: "01.in"}},
		"directory":          {{name: "dir/", typ: tar.TypeDir}},
		"nested path":        {{name: "sub/01.in", body: "x"}, {name: "sub/01.ans", body: "y"}},
		"parent path":        {{name: "../01.in", body: "x"}, {name: "../01.ans", body: "y"}},
		"absolute path":      {{name: "/tmp/01.in", body: "x"}, {name: "/tmp/01.ans", body: "y"}},
		"odd name":           {{name: "input.txt", body: "x"}},
		"one digit":          {{name: "1.in", body: "x"}, {name: "1.ans", body: "y"}},
		"five digits":        {{name: "00001.in", body: "x"}, {name: "00001.ans", body: "y"}},
		"missing answer":     {{name: "01.in", body: "x"}},
		"orphan answer":      {{name: "01.ans", body: "x"}},
		"answer for another": append(pair(1, "a", "b"), member{name: "02.ans", body: "c"}),
		"duplicate entry":    {{name: "01.in", body: "x"}, {name: "01.in", body: "x"}, {name: "01.ans", body: "y"}},
		"two names one test": append(pair(1, "a", "b"), pair(1, "c", "d")[0], member{name: "001.ans", body: "d"}),
		"empty archive":      {},
	}
	for name, ms := range bad {
		t.Run("FR-JUDGE-12: "+name+" is rejected", func(t *testing.T) {
			if name == "two names one test" {
				ms = []member{{name: "01.in", body: "a"}, {name: "01.ans", body: "b"}, {name: "001.in", body: "c"}, {name: "001.ans", body: "d"}}
			}
			st := newFakeStore()
			hash, u := seed(t, st, "a.tar", ms...)
			c := newCache(t, st, 0)
			if _, err := c.Get(ctx, hash, u); !errors.Is(err, ErrBadTestset) {
				t.Fatalf("got %v", err)
			}
			if entries, _ := os.ReadDir(c.cfg.Root); len(entries) != 1 { // only .tmp
				t.Fatalf("a rejected testset left files behind: %v", entries)
			}
		})
	}
	t.Run("FR-JUDGE-12: a truncated archive is rejected", func(t *testing.T) {
		st := newFakeStore()
		full := buildTar(t, pair(1, "0123456789", "y")...)
		cut := full[:600]
		st.put("testsets/a.tar", cut)
		if _, err := newCache(t, st, 0).Get(ctx, hashOf(cut), uri("a.tar")); !errors.Is(err, ErrBadTestset) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestLayoutAndOrder(t *testing.T) {
	ctx := context.Background()
	st := newFakeStore()
	hash, u := seed(t, st, "a.tar", append(append(pair(10, "t10", "a10"), pair(2, "t2", "a2")...), pair(1, "t1", "a1")...)...)
	c := newCache(t, st, 0)
	ts, err := c.Get(ctx, hash, u)
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Release()
	t.Run("tests come back in numeric order", func(t *testing.T) {
		var got []int
		for _, cs := range ts.Cases {
			got = append(got, cs.No)
		}
		if fmt.Sprint(got) != "[1 2 10]" {
			t.Fatalf("%v", got)
		}
	})
	t.Run("SD-§8.6: cache path is <root>/<hash>/NN.in with files 0440", func(t *testing.T) {
		if ts.Dir() != filepath.Join(c.cfg.Root, hash) {
			t.Fatalf("dir %s", ts.Dir())
		}
		fi, err := os.Stat(filepath.Join(ts.Dir(), "10.in"))
		if err != nil || fi.Mode().Perm() != 0o440 {
			t.Fatalf("%v %v", fi, err)
		}
		di, _ := os.Stat(ts.Dir())
		if di.Mode().Perm() != 0o550 {
			t.Fatalf("dir mode %v", di.Mode().Perm())
		}
	})
	t.Run("Load of an unknown test is an error", func(t *testing.T) {
		if _, _, err := ts.Load(3); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestConcurrentGetsShareOneDownload(t *testing.T) {
	t.Run("J-04: 20 concurrent Gets for one hash download once", func(t *testing.T) {
		st := newFakeStore()
		st.delay = 100 * time.Millisecond
		hash, u := seed(t, st, "a.tar", pair(1, "x", "y")...)
		c := newCache(t, st, 0)
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ts, err := c.Get(context.Background(), hash, u)
				if err != nil {
					t.Error(err)
					return
				}
				ts.Release()
			}()
		}
		wg.Wait()
		if n := st.opens.Load(); n != 1 {
			t.Fatalf("store opened %d times", n)
		}
	})
	t.Run("a waiter gives up when its context ends", func(t *testing.T) {
		st := newFakeStore()
		st.delay = 300 * time.Millisecond
		hash, u := seed(t, st, "a.tar", pair(1, "x", "y")...)
		c := newCache(t, st, 0)
		go func() {
			if ts, err := c.Get(context.Background(), hash, u); err == nil {
				ts.Release()
			}
		}()
		time.Sleep(50 * time.Millisecond)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		if _, err := c.Get(ctx, hash, u); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestLRUEviction(t *testing.T) {
	ctx := context.Background()
	// Each testset holds 100 bytes of test data.
	data := func(n int) []member { return pair(1, fmt.Sprintf("%050d", n), fmt.Sprintf("%050d", n+1)) }
	type set struct{ hash, uri string }
	setup := func(t *testing.T, max int64) (*Cache, *fakeStore, []set, *time.Time) {
		st := newFakeStore()
		var sets []set
		for i := 0; i < 4; i++ {
			h, u := seed(t, st, fmt.Sprintf("%d.tar", i), data(i*10)...)
			sets = append(sets, set{h, u})
		}
		clock := time.Unix(1_700_000_000, 0)
		c, err := New(Config{Root: tempRoot(t), MaxBytes: max, Store: st, Bucket: "codearena",
			Now: func() time.Time { clock = clock.Add(time.Second); return clock }})
		if err != nil {
			t.Fatal(err)
		}
		return c, st, sets, &clock
	}
	use := func(t *testing.T, c *Cache, s set) {
		t.Helper()
		ts, err := c.Get(ctx, s.hash, s.uri)
		if err != nil {
			t.Fatal(err)
		}
		ts.Release()
	}
	exists := func(c *Cache, s set) bool { _, err := os.Stat(filepath.Join(c.cfg.Root, s.hash)); return err == nil }

	t.Run("J-04 / SD-§8.6: the least recently used testset is evicted first", func(t *testing.T) {
		c, _, s, _ := setup(t, 250) // room for two
		use(t, c, s[0])
		use(t, c, s[1])
		use(t, c, s[0]) // s[1] is now the oldest
		use(t, c, s[2]) // 300 > 250: evict s[1]
		if !exists(c, s[0]) || exists(c, s[1]) || !exists(c, s[2]) {
			t.Fatalf("0:%v 1:%v 2:%v", exists(c, s[0]), exists(c, s[1]), exists(c, s[2]))
		}
		if c.Size() != 200 || c.Stats().Evictions != 1 {
			t.Fatalf("size %d stats %+v", c.Size(), c.Stats())
		}
	})
	t.Run("an evicted testset is downloaded again on the next use", func(t *testing.T) {
		c, st, s, _ := setup(t, 150)
		use(t, c, s[0])
		use(t, c, s[1]) // evicts s[0]
		before := st.opens.Load()
		use(t, c, s[0])
		if st.opens.Load() != before+1 {
			t.Fatal("expected a re-download")
		}
	})
	t.Run("a testset in use is never evicted", func(t *testing.T) {
		c, _, s, _ := setup(t, 150)
		held, err := c.Get(ctx, s[0].hash, s[0].uri)
		if err != nil {
			t.Fatal(err)
		}
		use(t, c, s[1])
		use(t, c, s[2])
		if !exists(c, s[0]) {
			t.Fatal("a testset that was still referenced got evicted")
		}
		if _, _, err := held.Load(1); err != nil {
			t.Fatal(err)
		}
		held.Release()
		held.Release() // idempotent
		use(t, c, s[3])
		if exists(c, s[0]) && c.Size() > 150 {
			t.Fatalf("the cache stayed over its limit: %d", c.Size())
		}
	})
	t.Run("the testset just fetched survives even if it alone exceeds the limit", func(t *testing.T) {
		c, _, s, _ := setup(t, 50)
		ts, err := c.Get(ctx, s[0].hash, s[0].uri)
		if err != nil {
			t.Fatal(err)
		}
		defer ts.Release()
		if _, _, err := ts.Load(1); err != nil {
			t.Fatal(err)
		}
	})
}

func TestRestart(t *testing.T) {
	ctx := context.Background()
	st := newFakeStore()
	hash, u := seed(t, st, "a.tar", pair(1, "in", "ans")...)
	root := tempRoot(t)
	cfg := Config{Root: root, Store: st, Bucket: "codearena"}
	c1, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ts, err := c1.Get(ctx, hash, u)
	if err != nil {
		t.Fatal(err)
	}
	ts.Release()

	// A crash left a half-written download and a bogus directory behind.
	must(t, os.MkdirAll(filepath.Join(root, ".tmp", "dl-123"), 0o750))
	must(t, os.WriteFile(filepath.Join(root, ".tmp", "dl-123", "archive.tar"), []byte("partial"), 0o600))
	bogus := hashOf([]byte("bogus"))
	must(t, os.MkdirAll(filepath.Join(root, bogus), 0o750))
	must(t, os.WriteFile(filepath.Join(root, bogus, "evil"), []byte("x"), 0o600))

	opens := st.opens.Load()
	c2, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("a restarted worker serves cached testsets without the store", func(t *testing.T) {
		ts, err := c2.Get(ctx, hash, u)
		if err != nil {
			t.Fatal(err)
		}
		defer ts.Release()
		if in, _, err := ts.Load(1); err != nil || string(in) != "in" {
			t.Fatalf("%q %v", in, err)
		}
		if st.opens.Load() != opens {
			t.Fatal("the store was contacted after a restart")
		}
	})
	t.Run("leftovers from a crash are removed and unrecognised directories are not trusted", func(t *testing.T) {
		if _, err := os.Stat(filepath.Join(root, ".tmp", "dl-123")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("half-written download survived")
		}
		if _, err := os.Stat(filepath.Join(root, bogus)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a directory that is not a valid testset survived")
		}
	})
	t.Run("a testset deleted behind the cache's back is fetched again", func(t *testing.T) {
		must(t, removeAll(filepath.Join(root, hash)))
		ts, err := c2.Get(ctx, hash, u)
		if err != nil {
			t.Fatal(err)
		}
		ts.Release()
		if st.opens.Load() != opens+1 {
			t.Fatal("expected one re-download")
		}
	})
}

func TestNewValidates(t *testing.T) {
	if _, err := New(Config{Root: t.TempDir(), Bucket: "b"}); err == nil {
		t.Fatal("no store accepted")
	}
	if _, err := New(Config{Root: t.TempDir(), Store: newFakeStore()}); err == nil {
		t.Fatal("no bucket accepted")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
