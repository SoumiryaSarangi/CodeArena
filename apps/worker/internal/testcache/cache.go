// Package testcache fetches testsets from object storage by content hash,
// verifies them, keeps them on disk and evicts the least recently used
// (SD-§8.6, FR-JUDGE-12).
package testcache

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

// DefaultMaxBytes is the cache size limit from SD-§8.6.
const DefaultMaxBytes = 5 << 30

var (
	ErrNotFound     = errors.New("testcache: object not found")
	ErrBadURI       = errors.New("testcache: bad testset URI")
	ErrBadHash      = errors.New("testcache: bad testset hash")
	ErrHashMismatch = errors.New("testcache: testset hash mismatch")
	ErrTooLarge     = errors.New("testcache: testset archive too large")
)

var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Config sets up a Cache.
type Config struct {
	Root     string // cache directory, e.g. /var/cache/codearena/tests
	MaxBytes int64  // default DefaultMaxBytes
	Store    Store
	Bucket   string // the only bucket testset URIs may name
	Prefix   string // required key prefix; default "testsets/"
	// Now is the clock for LRU ordering; default time.Now.
	Now func() time.Time
}

// Stats counts cache activity; J-05 exports them as metrics.
type Stats struct {
	Hits, Misses, Downloads, Evictions, Failures int64
}

type entry struct {
	size     int64
	lastUsed time.Time
	refs     int
	cases    []Case
}

type flight struct {
	done chan struct{}
	err  error
}

// Cache is safe for concurrent use.
type Cache struct {
	cfg     Config
	tmp     string
	mu      sync.Mutex
	entries map[string]*entry
	flights map[string]*flight
	stats   [5]atomic.Int64
}

// New opens the cache directory, drops half-written downloads left by a crash
// and indexes the testsets already on disk.
func New(cfg Config) (*Cache, error) {
	if cfg.Store == nil || cfg.Bucket == "" || cfg.Root == "" {
		return nil, errors.New("testcache: store, bucket and root are required")
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = DefaultMaxBytes
	}
	if cfg.Prefix == "" {
		cfg.Prefix = "testsets/"
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if err := os.MkdirAll(cfg.Root, 0o750); err != nil {
		return nil, err
	}
	c := &Cache{cfg: cfg, tmp: filepath.Join(cfg.Root, ".tmp"), entries: map[string]*entry{}, flights: map[string]*flight{}}
	if err := removeAll(c.tmp); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(c.tmp, 0o750); err != nil {
		return nil, err
	}
	des, err := os.ReadDir(cfg.Root)
	if err != nil {
		return nil, err
	}
	for _, de := range des {
		if !de.IsDir() || !hashRe.MatchString(de.Name()) {
			continue
		}
		dir := filepath.Join(cfg.Root, de.Name())
		e, err := index(dir)
		if err != nil {
			// A directory we cannot make sense of is deleted, not trusted.
			if rerr := removeAll(dir); rerr != nil {
				return nil, rerr
			}
			continue
		}
		c.entries[de.Name()] = e
	}
	return c, nil
}

// index rebuilds an entry from a directory already on disk.
func index(dir string) (*entry, error) {
	st, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	names, err := sandbox.ListFiles(dir)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var size int64
	for _, n := range names {
		fi, err := os.Lstat(filepath.Join(dir, n))
		if err != nil || !fi.Mode().IsRegular() || !entryName.MatchString(n) {
			return nil, ErrBadTestset
		}
		seen[n] = true
		size += fi.Size()
	}
	cases, err := pairs(seen)
	if err != nil {
		return nil, err
	}
	return &entry{size: size, lastUsed: st.ModTime(), cases: cases}, nil
}

// Stats returns a snapshot of the counters.
func (c *Cache) Stats() Stats {
	return Stats{c.stats[0].Load(), c.stats[1].Load(), c.stats[2].Load(), c.stats[3].Load(), c.stats[4].Load()}
}

func (c *Cache) count(i int) { c.stats[i].Add(1) }

const (
	sHit = iota
	sMiss
	sDownload
	sEvict
	sFail
)

// Testset is a cached, verified testset. Call Release when judging is done so
// eviction can reclaim it.
type Testset struct {
	Hash  string
	Cases []Case
	dir   string
	c     *Cache
	once  sync.Once
}

// Dir is the testset directory on disk.
func (t *Testset) Dir() string { return t.dir }

// Load reads one test's input and expected answer.
func (t *Testset) Load(no int) (in, ans []byte, err error) {
	for _, cs := range t.Cases {
		if cs.No != no {
			continue
		}
		if in, _, err = sandbox.ReadFile(t.dir, cs.base+".in", MaxFileBytes); err != nil {
			return nil, nil, err
		}
		if ans, _, err = sandbox.ReadFile(t.dir, cs.base+".ans", MaxFileBytes); err != nil {
			return nil, nil, err
		}
		return in, ans, nil
	}
	return nil, nil, fmt.Errorf("testcache: no test %d", no)
}

// Release marks the testset no longer in use. It is safe to call twice.
func (t *Testset) Release() {
	t.once.Do(func() {
		t.c.mu.Lock()
		defer t.c.mu.Unlock()
		if e := t.c.entries[t.Hash]; e != nil && e.refs > 0 {
			e.refs--
		}
		t.c.evictLocked("")
	})
}

// Get returns the testset with the given content hash, downloading it from
// uri only if it is not already on disk. The archive's SHA-256 must equal
// hash, or nothing is stored (FR-JUDGE-12). Concurrent Gets for the same hash
// share one download.
func (c *Cache) Get(ctx context.Context, hash, uri string) (*Testset, error) {
	if !hashRe.MatchString(hash) {
		return nil, ErrBadHash
	}
	bucket, key, err := c.parseURI(uri)
	if err != nil {
		return nil, err
	}
	for {
		c.mu.Lock()
		if e := c.entries[hash]; e != nil {
			dir := filepath.Join(c.cfg.Root, hash)
			if _, err := os.Stat(dir); err != nil {
				delete(c.entries, hash) // vanished from disk: fall through to a re-download
			} else {
				e.refs++
				e.lastUsed = c.cfg.Now()
				_ = os.Chtimes(dir, e.lastUsed, e.lastUsed)
				cases := e.cases
				c.mu.Unlock()
				c.count(sHit)
				return &Testset{Hash: hash, Cases: cases, dir: dir, c: c}, nil
			}
		}
		if f := c.flights[hash]; f != nil {
			c.mu.Unlock()
			select {
			case <-f.done:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		f := &flight{done: make(chan struct{})}
		c.flights[hash] = f
		c.mu.Unlock()

		c.count(sMiss)
		e, err := c.fetch(ctx, hash, bucket, key)
		c.mu.Lock()
		delete(c.flights, hash)
		if err == nil {
			e.refs = 1
			c.entries[hash] = e
			c.evictLocked(hash)
		} else {
			c.count(sFail)
		}
		f.err = err
		close(f.done)
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return &Testset{Hash: hash, Cases: e.cases, dir: filepath.Join(c.cfg.Root, hash), c: c}, nil
	}
}

// parseURI accepts only s3://<configured bucket>/<prefix>... so a job cannot
// point the judge at another bucket or at keys outside the testsets prefix.
func (c *Cache) parseURI(uri string) (bucket, key string, err error) {
	u, perr := url.Parse(uri)
	if perr != nil || u.Scheme != "s3" || u.Host != c.cfg.Bucket || u.RawQuery != "" || u.Fragment != "" {
		return "", "", fmt.Errorf("%w: %q", ErrBadURI, uri)
	}
	key = strings.TrimPrefix(u.Path, "/")
	if path.Clean(key) != key || !strings.HasPrefix(key, c.cfg.Prefix) || strings.Contains(key, "\x00") {
		return "", "", fmt.Errorf("%w: key %q", ErrBadURI, key)
	}
	return u.Host, key, nil
}

// fetch downloads to a temp file (hashing as it streams, size-capped),
// verifies the hash, extracts into a temp directory and renames it into place.
func (c *Cache) fetch(ctx context.Context, hash, bucket, key string) (*entry, error) {
	body, size, err := c.cfg.Store.Open(ctx, bucket, key)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	if size > MaxTarBytes {
		return nil, fmt.Errorf("%w: %d bytes", ErrTooLarge, size)
	}
	c.count(sDownload)

	work, err := os.MkdirTemp(c.tmp, "dl-")
	if err != nil {
		return nil, err
	}
	defer func() { _ = removeAll(work) }()

	tarPath := filepath.Join(work, "archive.tar")
	f, err := os.OpenFile(tarPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(body, MaxTarBytes+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	if n > MaxTarBytes {
		return nil, ErrTooLarge
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != hash {
		return nil, fmt.Errorf("%w: archive is %s, job expects %s", ErrHashMismatch, got, hash)
	}

	rf, err := os.Open(tarPath)
	if err != nil {
		return nil, err
	}
	defer rf.Close()
	out := filepath.Join(work, "out")
	if err := os.Mkdir(out, 0o750); err != nil {
		return nil, err
	}
	cases, err := extract(rf, out)
	if err != nil {
		return nil, err
	}
	var total int64
	for _, cs := range cases {
		for _, ext := range []string{".in", ".ans"} {
			fi, err := os.Lstat(filepath.Join(out, cs.base+ext))
			if err != nil {
				return nil, err
			}
			total += fi.Size()
		}
	}
	dst := filepath.Join(c.cfg.Root, hash)
	// Moving a directory to a new parent needs write permission on it, so it
	// becomes read-only (0550) only after the rename.
	if err := os.Rename(out, dst); err != nil {
		// A leftover directory from a crash between rename and index: replace it.
		if rerr := removeAll(dst); rerr != nil {
			return nil, err
		}
		if err := os.Rename(out, dst); err != nil {
			return nil, err
		}
	}
	if err := os.Chmod(dst, 0o550); err != nil {
		return nil, err
	}
	now := c.cfg.Now()
	_ = os.Chtimes(dst, now, now)
	return &entry{size: total, lastUsed: now, cases: cases}, nil
}

// evictLocked removes least-recently-used unreferenced testsets until the
// cache fits MaxBytes. keep is never evicted. Caller holds c.mu.
func (c *Cache) evictLocked(keep string) {
	var total int64
	for _, e := range c.entries {
		total += e.size
	}
	if total <= c.cfg.MaxBytes {
		return
	}
	type cand struct {
		hash string
		e    *entry
	}
	var cands []cand
	for h, e := range c.entries {
		if e.refs == 0 && h != keep {
			cands = append(cands, cand{h, e})
		}
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].e.lastUsed.Before(cands[j].e.lastUsed) })
	for _, cd := range cands {
		if total <= c.cfg.MaxBytes {
			return
		}
		// Rename first so a crash mid-delete leaves no half-evicted testset
		// under its hash, then remove it.
		live := filepath.Join(c.cfg.Root, cd.hash)
		_ = os.Chmod(live, 0o750) // see fetch: a rename needs write permission
		gone := filepath.Join(c.tmp, "evict-"+randHex())
		if err := os.Rename(live, gone); err != nil && !errors.Is(err, os.ErrNotExist) {
			_ = os.Chmod(live, 0o550)
			continue
		}
		_ = removeAll(gone)
		delete(c.entries, cd.hash)
		total -= cd.e.size
		c.count(sEvict)
	}
}

// Size is the total bytes of cached testsets.
func (c *Cache) Size() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	var total int64
	for _, e := range c.entries {
		total += e.size
	}
	return total
}

func randHex() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// removeAll deletes a tree whose directories are read-only (0550).
func removeAll(p string) error {
	_ = filepath.WalkDir(p, func(path string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			_ = os.Chmod(path, 0o750)
		}
		return nil
	})
	return os.RemoveAll(p)
}
