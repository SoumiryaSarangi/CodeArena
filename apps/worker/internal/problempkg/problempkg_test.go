package problempkg

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/testcache"
)

const validYAML = `title: Demo
rating: 800
practicePoints: 8
tags: [demo]
limits: {timeMs: 1000, memMb: 256, outputKb: 64}
checker: {kind: tokens}
samples: ['01']
avoidSet: {1: [a], 2: [b]}
generator: generators/gen.py
solutions:
  - {file: main.cpp, expected: AC}
  - {file: wa.cpp, expected: WA}
`

const validStatement = "# Demo\n\ntext\n\n## Input\n\nx\n\n## Output\n\ny\n\n## Notes\n\nz\n"

// writePkg builds a valid package directory named "demo" and lets the test change it.
func writePkg(t *testing.T, mutate func(dir string)) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "demo")
	files := map[string]string{
		"problem.yaml": validYAML, "statement.md": validStatement, "editorial.md": "e", "validator.cpp": "int main(){}",
		"tests/01.in": "1\n", "tests/01.ans": "1\n", "tests/02.in": "2\n", "tests/02.ans": "2\n",
		"solutions/main.cpp": "int main(){}", "solutions/wa.cpp": "int main(){}",
	}
	for rel, c := range files {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if mutate != nil {
		mutate(dir)
	}
	return dir
}

func edit(t *testing.T, dir, rel string, f func(string) string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(f(string(b))), 0o644); err != nil {
		t.Fatal(err)
	}
}

func remove(t *testing.T, dir, rel string) {
	t.Helper()
	if err := os.Remove(filepath.Join(dir, rel)); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadValid(t *testing.T) {
	p, err := Load(writePkg(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	if p.Slug != "demo" || len(p.Tests) != 2 || p.Meta.Rating != 800 || p.Checker().Kind != contracts.CheckerKindTokens {
		t.Fatalf("%+v", p)
	}
	if l := p.Limits(); l.TimeMS != 1000 || l.MemMB != 256 || l.OutputKB != 64 {
		t.Fatalf("%+v", l)
	}
}

func TestLoadRejects(t *testing.T) {
	sub := func(old, new string) func(string) string {
		return func(s string) string {
			if !strings.Contains(s, old) {
				panic("missing " + old)
			}
			return strings.Replace(s, old, new, 1)
		}
	}
	cases := []struct {
		name   string
		mutate func(t *testing.T, dir string)
		want   string
	}{
		{"statement without Notes", func(t *testing.T, d string) { edit(t, d, "statement.md", sub("## Notes\n\nz\n", "")) }, "no '## Notes'"},
		{"statement without Input", func(t *testing.T, d string) { edit(t, d, "statement.md", sub("## Input", "## Inputs")) }, "no '## Input'"},
		{"statement without title", func(t *testing.T, d string) { edit(t, d, "statement.md", sub("# Demo", "Demo")) }, "must start with"},
		{"missing editorial", func(t *testing.T, d string) { remove(t, d, "editorial.md") }, "editorial.md is missing"},
		{"missing validator", func(t *testing.T, d string) { remove(t, d, "validator.cpp") }, "validator.cpp is missing"},
		{"numbering gap", func(t *testing.T, d string) {
			remove(t, d, "tests/02.in")
			remove(t, d, "tests/02.ans")
			write(t, d, "tests/03.in", "3")
			write(t, d, "tests/03.ans", "3")
		}, "numbering has a gap"},
		{"input without answer", func(t *testing.T, d string) { remove(t, d, "tests/02.ans") }, "no matching .ans"},
		{"answer without input", func(t *testing.T, d string) { remove(t, d, "tests/02.in") }, "no matching .in"},
		{"stray file in tests", func(t *testing.T, d string) { write(t, d, "tests/notes.txt", "x") }, "not a regular NN.in"},
		{"samples out of order", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("samples: ['01']", "samples: ['02']")) }, "first tests in order"},
		{"too many samples", func(t *testing.T, d string) {
			edit(t, d, "problem.yaml", sub("samples: ['01']", "samples: ['01','02','03']"))
		}, "more tests than exist"},
		{"no samples", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("samples: ['01']", "samples: []")) }, "at least one sample"},
		{"rating not a multiple of 100", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("rating: 800", "rating: 850")) }, "multiple of 100"},
		{"practice points mismatch", func(t *testing.T, d string) {
			edit(t, d, "problem.yaml", sub("practicePoints: 8", "practicePoints: 9"))
		}, "practicePoints must be rating/100"},
		{"no tags", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("tags: [demo]", "tags: []")) }, "at least one tag"},
		{"limits out of range", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("timeMs: 1000", "timeMs: 50")) }, "limits out of range"},
		{"float without eps", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("kind: tokens", "kind: float")) }, "needs a positive eps"},
		{"eps on tokens", func(t *testing.T, d string) {
			edit(t, d, "problem.yaml", sub("kind: tokens}", "kind: tokens, eps: 0.1}"))
		}, "only for the float"},
		{"unknown checker", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("kind: tokens", "kind: magic")) }, "unknown checker kind"},
		{"testlib without checker.cpp", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("kind: tokens", "kind: testlib")) }, "checker.cpp is missing"},
		{"checker.cpp with tokens", func(t *testing.T, d string) { write(t, d, "checker.cpp", "x") }, "checker.cpp exists"},
		{"avoidSet level 3", func(t *testing.T, d string) {
			edit(t, d, "problem.yaml", sub("avoidSet: {1: [a], 2: [b]}", "avoidSet: {3: [a]}"))
		}, "only 1 and 2"},
		{"unknown yaml field", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("title: Demo", "title: Demo\nbogus: 1")) }, "bogus"},
		{"solution without expected verdict", func(t *testing.T, d string) { write(t, d, "solutions/extra.py", "x") }, "no expected verdict"},
		{"declared solution missing", func(t *testing.T, d string) { remove(t, d, "solutions/wa.cpp") }, "declared but missing"},
		{"no AC solution", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("expected: AC", "expected: WA")) }, "at least one must be expected AC"},
		{"bad expected verdict", func(t *testing.T, d string) { edit(t, d, "problem.yaml", sub("expected: WA", "expected: SE")) }, "not one of"},
		{"unknown language", func(t *testing.T, d string) {
			write(t, d, "solutions/x.rb", "x")
			edit(t, d, "problem.yaml", sub("  - {file: wa.cpp, expected: WA}", "  - {file: wa.cpp, expected: WA}\n  - {file: x.rb, expected: WA}"))
		}, "unknown language extension"},
		{"duplicate solution", func(t *testing.T, d string) {
			edit(t, d, "problem.yaml", sub("  - {file: wa.cpp, expected: WA}", "  - {file: wa.cpp, expected: WA}\n  - {file: wa.cpp, expected: WA}"))
		}, "declared twice"},
		{"solution path escapes", func(t *testing.T, d string) {
			edit(t, d, "problem.yaml", sub("  - {file: wa.cpp, expected: WA}", "  - {file: ../x.cpp, expected: WA}"))
		}, "plain name"},
	}
	for _, c := range cases {
		t.Run("FR-PROB-01: rejects "+c.name, func(t *testing.T) {
			_, err := Load(writePkg(t, func(d string) { c.mutate(t, d) }))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want an error containing %q, got %v", c.want, err)
			}
		})
	}

	t.Run("FR-PROB-01: errors are itemised, not just the first one", func(t *testing.T) {
		_, err := Load(writePkg(t, func(d string) {
			remove(t, d, "editorial.md")
			remove(t, d, "validator.cpp")
			edit(t, d, "problem.yaml", sub("rating: 800", "rating: 850"))
		}))
		for _, w := range []string{"editorial.md", "validator.cpp", "multiple of 100"} {
			if err == nil || !strings.Contains(err.Error(), w) {
				t.Fatalf("missing %q in %v", w, err)
			}
		}
	})
	t.Run("a bad directory name is rejected", func(t *testing.T) {
		dir := writePkg(t, nil)
		bad := filepath.Join(filepath.Dir(dir), "Bad_Name")
		if err := os.Rename(dir, bad); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(bad); err == nil || !strings.Contains(err.Error(), "not a slug") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a missing problem.yaml is an error", func(t *testing.T) {
		if _, err := Load(t.TempDir()); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestLanguageOf(t *testing.T) {
	for file, want := range map[string]contracts.Language{"a.cpp": "cpp17", "b.PY": "python3", "c.c": "c", "D.java": "java21", "e.js": "node"} {
		if got, ok := LanguageOf(file); !ok || got != want {
			t.Errorf("%s: %v %v", file, got, ok)
		}
	}
	if _, ok := LanguageOf("x.rb"); ok {
		t.Error("rb is not a language")
	}
}

func TestTar(t *testing.T) {
	p, err := Load(writePkg(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("FR-PROB-03: the testset tar is flat, ordered and byte-identical on every build", func(t *testing.T) {
		a, ha, err := p.Tar()
		if err != nil {
			t.Fatal(err)
		}
		b, hb, _ := p.Tar()
		if !bytes.Equal(a, b) || ha != hb || len(ha) != 64 {
			t.Fatal("tar is not reproducible")
		}
		tr := tar.NewReader(bytes.NewReader(a))
		var names []string
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil || h.Typeflag != tar.TypeReg || h.ModTime.Unix() != 0 || h.Uid != 0 || h.Mode != 0o644 {
				t.Fatalf("%+v %v", h, err)
			}
			names = append(names, h.Name)
		}
		if fmt.Sprint(names) != "[01.in 01.ans 02.in 02.ans]" {
			t.Fatalf("%v", names)
		}
	})
	t.Run("FR-PROB-03: the judge's testset cache accepts the archive and returns the same tests", func(t *testing.T) {
		data, hash, _ := p.Tar()
		store := &oneObject{key: "testsets/demo.tar", data: data}
		root := filepath.Join(t.TempDir(), "cache")
		c, err := testcache.New(testcache.Config{Root: root, Store: store, Bucket: "codearena"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { // cached testsets are read-only
			_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
				if err == nil && d.IsDir() {
					_ = os.Chmod(p, 0o750)
				}
				return nil
			})
		})
		ts, err := c.Get(context.Background(), hash, "s3://codearena/testsets/demo.tar")
		if err != nil {
			t.Fatal(err)
		}
		defer ts.Release()
		for _, want := range p.Tests {
			in, ans, err := ts.Load(want.No)
			if err != nil || !bytes.Equal(in, want.In) || !bytes.Equal(ans, want.Ans) {
				t.Fatalf("test %d: %q %q %v", want.No, in, ans, err)
			}
		}
	})
}

type oneObject struct {
	key  string
	data []byte
}

func (o *oneObject) Open(_ context.Context, bucket, key string) (io.ReadCloser, int64, error) {
	if bucket != "codearena" || key != o.key {
		return nil, 0, testcache.ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(o.data)), int64(len(o.data)), nil
}

// TestRepositoryProblems loads every package under problems/ (no sandbox
// needed): J-06 acceptance, structural half. scripts/validate-problem does the
// judging half.
func TestRepositoryProblems(t *testing.T) {
	root := "../../../../problems"
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Skipf("no problems directory: %v", err)
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), "_") {
			continue
		}
		n++
		t.Run("FR-PROB-01: "+e.Name(), func(t *testing.T) {
			p, err := Load(filepath.Join(root, e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := p.Tar(); err != nil {
				t.Fatal(err)
			}
			kinds := map[contracts.Verdict]bool{}
			for _, s := range p.Meta.Solutions {
				kinds[s.Expected] = true
			}
			for _, v := range []contracts.Verdict{"AC", "WA", "TLE", "RE", "MLE", "OLE"} {
				if !kinds[v] {
					t.Errorf("no solution expects %s", v)
				}
			}
		})
	}
	if n < 20 {
		t.Fatalf("J-06 needs 20 practice problems, found %d", n)
	}
}
