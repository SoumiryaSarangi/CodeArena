package languages

import (
	"strings"
	"testing"
	"time"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

func TestDefaultRegistry(t *testing.T) {
	r, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	t.Run("FR-JUDGE-01: C, C++17, C++20, Python 3, Java 21 and Node are registered", func(t *testing.T) {
		want := []contracts.Language{"c", "cpp17", "cpp20", "python3", "java21", "node"}
		got := r.IDs()
		if len(got) != len(want) {
			t.Fatalf("ids %v", got)
		}
		for _, id := range want {
			if _, ok := r.Get(id); !ok {
				t.Fatalf("missing %s", id)
			}
		}
		if _, ok := r.Get("ruby"); ok {
			t.Fatal("unknown language found")
		}
	})
	t.Run("FR-JUDGE-02: compile limits are 10 s CPU, 512 MB, 64 processes, 16 KB log", func(t *testing.T) {
		c := r.Limits
		if c.CPUSeconds != 10 || c.MemMB != 512 || c.Processes != 64 || c.LogKB != 16 {
			t.Fatalf("%+v", c)
		}
	})
	t.Run("every registry id is a contracts language", func(t *testing.T) {
		valid := map[contracts.Language]bool{contracts.LanguageC: true, contracts.LanguageCpp17: true, contracts.LanguageCpp20: true,
			contracts.LanguageJava21: true, contracts.LanguageNode: true, contracts.LanguagePython3: true}
		for _, id := range r.IDs() {
			if !valid[id] {
				t.Fatalf("%s is not in contracts", id)
			}
		}
	})
}

func TestRunSpec(t *testing.T) {
	r, _ := Default()
	lim := contracts.Limits{TimeMS: 2000, MemMB: 256, OutputKB: 65536}
	get := func(id contracts.Language) *Language { l, _ := r.Get(id); return l }

	t.Run("SD-§8.3: C gets 1 process, no overhead, multiplier 1", func(t *testing.T) {
		s := get("c").RunSpec(lim, "in.txt", "out.txt", "err.txt")
		if s.TimeLimit != 2*time.Second || s.MemKB != 256*1024 || s.Processes != 1 || s.FsizeKB != 65537 {
			t.Fatalf("%+v", s)
		}
		if err := s.Validate(); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("SD-§8.3: Java gets 32 processes, +64 MB, -Xmx from the problem limit", func(t *testing.T) {
		s := get("java21").RunSpec(lim, "", "", "")
		if s.Processes != 32 || s.MemKB != (256+64)*1024 || s.TimeLimit != 4*time.Second {
			t.Fatalf("%+v", s)
		}
		if !strings.Contains(strings.Join(s.Cmd, " "), "-Xmx256m") || strings.Contains(strings.Join(s.Cmd, " "), "{MEM_MB}") {
			t.Fatalf("cmd %q", s.Cmd)
		}
		if err := s.Validate(); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("SD-§8.3: Python +16 MB, Node 16 processes +48 MB", func(t *testing.T) {
		if s := get("python3").RunSpec(lim, "", "", ""); s.MemKB != (256+16)*1024 || s.Processes != 1 {
			t.Fatalf("%+v", s)
		}
		if s := get("node").RunSpec(lim, "", "", ""); s.MemKB != (256+48)*1024 || s.Processes != 16 {
			t.Fatalf("%+v", s)
		}
	})
	t.Run("every language yields a valid run spec", func(t *testing.T) {
		for _, id := range r.IDs() {
			if err := get(id).RunSpec(lim, "in.txt", "out.txt", "err.txt").Validate(); err != nil {
				t.Fatalf("%s: %v", id, err)
			}
		}
	})
}

func TestParseRejects(t *testing.T) {
	good := `
compile: {cpuSeconds: 10, memMb: 512, fsizeKb: 1024, processes: 8, logKb: 16}
languages:
  - {id: c, name: C, sourceFile: main.c, compile: [gcc], run: [./main], artifacts: [main], processes: 1, memOverheadMb: 0, timeMultiplier: 1}
`
	if _, err := Parse([]byte(good)); err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"unknown key":       strings.Replace(good, "name: C,", "name: C, bogus: 1,", 1),
		"no compile limits": strings.Replace(good, "cpuSeconds: 10", "cpuSeconds: 0", 1),
		"path in source":    strings.Replace(good, "main.c", "../main.c", 1),
		"no run":            strings.Replace(good, "run: [./main]", "run: []", 1),
		"no artifacts":      strings.Replace(good, "artifacts: [main]", "artifacts: []", 1),
		"bad multiplier":    strings.Replace(good, "timeMultiplier: 1", "timeMultiplier: 0", 1),
		"bad glob":          strings.Replace(good, "artifacts: [main]", `artifacts: ["[a"]`, 1),
		"slash in glob":     strings.Replace(good, "artifacts: [main]", `artifacts: ["a/b"]`, 1),
		"rw bind":           strings.Replace(good, "processes: 1,", "dirs: [\"/usr/lib:rw\"], processes: 1,", 1),
		"duplicate id":      good + "  - {id: c, name: C, sourceFile: main.c, compile: [gcc], run: [./main], artifacts: [main], processes: 1, memOverheadMb: 0, timeMultiplier: 1}\n",
		"not yaml":          "languages: [",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(in)); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}
