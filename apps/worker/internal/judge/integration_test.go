package judge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/languages"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

// Needs isolate. JUDGE_REQUIRE_ISOLATE=1 makes a missing isolate a failure;
// JUDGE_REQUIRE_RUNTIMES=1 does the same for a missing language runtime.
type env struct {
	ctx      context.Context
	pool     *sandbox.Pool
	reg      *languages.Registry
	eng      *Engine
	checkers map[string]checkerBuild // compiled once per file: testlib is slow to build
}

type checkerBuild struct {
	bin []byte
	err error
}

func setup(t *testing.T) *env {
	t.Helper()
	for _, bin := range []string{"isolate", "taskset"} {
		if _, err := exec.LookPath(bin); err != nil {
			skipOr(t, "JUDGE_REQUIRE_ISOLATE", "%s not installed", bin)
		}
	}
	ctx := context.Background()
	core := min(3, runtime.NumCPU()-1)
	// Box ids 960+ keep clear of the sandbox (900+) and languages (930+) tests.
	pool, err := sandbox.New(ctx, sandbox.Config{Cores: []int{core}, BoxIDBase: 960})
	if err != nil {
		skipOr(t, "JUDGE_REQUIRE_ISOLATE", "isolate unusable: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close(ctx) })
	reg, err := languages.Default()
	if err != nil {
		t.Fatal(err)
	}
	return &env{ctx, pool, reg, &Engine{Reg: reg}, map[string]checkerBuild{}}
}

func skipOr(t *testing.T, envVar, format string, args ...any) {
	t.Helper()
	if os.Getenv(envVar) == "1" {
		t.Fatalf(format, args...)
	}
	t.Skipf(format, args...)
}

func (e *env) judge(t *testing.T, req Request) *Outcome {
	t.Helper()
	slot, err := e.pool.Acquire(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = e.pool.Release(e.ctx, slot) }()
	out, err := e.eng.Run(e.ctx, slot, req, nil)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func (e *env) checkerBinary(t *testing.T, file string) ([]byte, error) {
	t.Helper()
	if b, ok := e.checkers[file]; ok {
		return b.bin, b.err
	}
	bin, err := e.compileChecker(t, file)
	e.checkers[file] = checkerBuild{bin, err}
	return bin, err
}

func (e *env) compileChecker(t *testing.T, file string) ([]byte, error) {
	t.Helper()
	src, err := os.ReadFile("testdata/" + file)
	if err != nil {
		t.Fatal(err)
	}
	slot, _ := e.pool.Acquire(e.ctx)
	defer func() { _ = e.pool.Release(e.ctx, slot) }()
	return CompileChecker(e.ctx, e.reg, slot.Compile, string(src))
}

var limits = contracts.Limits{TimeMS: 500, MemMB: 128, OutputKB: 64}

func sumTests() []Test { return []Test{{No: 1, In: []byte("1 2\n"), Ans: []byte("3\n")}} }

// programs[language][verdict]: read two integers and print their sum, or
// misbehave in the way the verdict names.
var programs = map[contracts.Language]map[contracts.Verdict]string{
	"c": {
		"AC":  `#include <stdio.h>` + "\n" + `int main(){long a,b;scanf("%ld %ld",&a,&b);printf("%ld\n",a+b);return 0;}`,
		"WA":  `#include <stdio.h>` + "\n" + `int main(){long a,b;scanf("%ld %ld",&a,&b);printf("%ld\n",a+b+1);return 0;}`,
		"TLE": `int main(){volatile long x=0;for(;;)x++;}`,
		"MLE": `#include <stdlib.h>` + "\n" + `#include <string.h>` + "\n" + `int main(){size_t n=1u<<30;volatile char*p=malloc(n);if(!p)return 0;memset((void*)p,1,n);return p[n-1]==5;}`,
		"RE":  `int main(){volatile int*p=0;*p=1;return 0;}`,
		"OLE": `#include <stdio.h>` + "\n" + `int main(){for(int i=0;i<200000;i++)puts("0123456789012345678901234567890123456789");return 0;}`,
		"CE":  `int main( {`,
	},
	"cpp17": cppPrograms,
	"cpp20": cppPrograms,
	"python3": {
		"AC":  "a,b=map(int,input().split())\nprint(a+b)\n",
		"WA":  "a,b=map(int,input().split())\nprint(a+b+1)\n",
		"TLE": "while True:\n    pass\n",
		"MLE": "x = b'a' * (1 << 30)\nprint(len(x))\n",
		"RE":  "raise Exception('boom')\n",
		"OLE": "for i in range(200000):\n    print('0123456789' * 4)\n",
		"CE":  "def f(:\n    pass\n",
	},
	"java21": {
		"AC":  `import java.util.*;public class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);long a=s.nextLong(),b=s.nextLong();System.out.println(a+b);}}`,
		"WA":  `import java.util.*;public class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);long a=s.nextLong(),b=s.nextLong();System.out.println(a+b+1);}}`,
		"TLE": `public class Main{public static void main(String[] x){long i=0;while(true){i++;}}}`,
		"MLE": `public class Main{public static void main(String[] x){byte[] b=new byte[1<<30];b[5]=1;System.out.println(b[5]);}}`,
		"RE":  `public class Main{public static void main(String[] x){throw new RuntimeException("boom");}}`,
		"OLE": `public class Main{public static void main(String[] x){StringBuilder sb=new StringBuilder();for(int i=0;i<2000000;i++)sb.append("0123456789\n");System.out.print(sb);}}`,
		"CE":  `public class Main{ void`,
	},
	"node": {
		"AC":  "const [a,b]=require('fs').readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);console.log(a+b);\n",
		"WA":  "const [a,b]=require('fs').readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);console.log(a+b+1);\n",
		"TLE": "let i=0;while(true){i++;}\n",
		"MLE": "const b=Buffer.alloc(1<<30,1);console.log(b[5]);\n",
		"RE":  "throw new Error('boom');\n",
		"OLE": "process.stdout.write('0123456789\\n'.repeat(2000000));\n",
		"CE":  "function (\n",
	},
}

var cppPrograms = map[contracts.Verdict]string{
	"AC":  `#include <cstdio>` + "\n" + `int main(){long a,b;scanf("%ld %ld",&a,&b);printf("%ld\n",a+b);return 0;}`,
	"WA":  `#include <cstdio>` + "\n" + `int main(){long a,b;scanf("%ld %ld",&a,&b);printf("%ld\n",a+b+1);return 0;}`,
	"TLE": `int main(){volatile long x=0;for(;;)x++;}`,
	"MLE": `#include <cstdlib>` + "\n" + `#include <cstring>` + "\n" + `int main(){size_t n=1u<<30;volatile char*p=(volatile char*)malloc(n);if(!p)return 0;memset((void*)p,1,n);return p[n-1]==5;}`,
	"RE":  `int main(){volatile int*p=0;*p=1;return 0;}`,
	"OLE": `#include <cstdio>` + "\n" + `int main(){for(int i=0;i<200000;i++)puts("0123456789012345678901234567890123456789");return 0;}`,
	"CE":  `int main( {`,
}

var runtimeFor = map[contracts.Language]string{"c": "/usr/bin/gcc", "cpp17": "/usr/bin/g++", "cpp20": "/usr/bin/g++", "python3": "/usr/bin/python3",
	"java21": "/usr/lib/jvm/java-21-openjdk-amd64/bin/javac", "node": "/usr/bin/node"}

func TestVerdictMatrix(t *testing.T) {
	e := setup(t)
	verdicts := []contracts.Verdict{"AC", "WA", "TLE", "MLE", "RE", "OLE", "CE"}
	for _, lang := range e.reg.IDs() {
		for _, want := range verdicts {
			t.Run("FR-JUDGE-05: "+string(lang)+" "+string(want), func(t *testing.T) {
				if _, err := os.Stat(runtimeFor[lang]); err != nil {
					skipOr(t, "JUDGE_REQUIRE_RUNTIMES", "%s is not installed", runtimeFor[lang])
				}
				src, ok := programs[lang][want]
				if !ok {
					t.Fatalf("no %s program for %s", want, lang)
				}
				out := e.judge(t, Request{
					Language: lang, Source: src, Limits: limits,
					Checker: contracts.Checker{Kind: contracts.CheckerKindTokens},
					Tests:   sumTests(),
				})
				if out.Verdict != want {
					t.Fatalf("got %s, want %s\ncompile log: %s\ntests: %+v", out.Verdict, want, out.CompileLog, out.Tests)
				}
				if want == "CE" {
					if out.CompileLog == "" || len(out.Tests) != 0 {
						t.Fatalf("CE needs a log and no tests: %+v", out)
					}
					return
				}
				if len(out.Tests) != 1 || out.Tests[0].Verdict != want {
					t.Fatalf("tests %+v", out.Tests)
				}
				if want == "AC" && (out.TimeMS <= 0 || out.MemKB <= 0) {
					t.Fatalf("no usage reported: %+v", out)
				}
				if want == "WA" && (out.Tests[0].CheckerMsg == nil || !strings.Contains(*out.Tests[0].CheckerMsg, "token 1")) {
					t.Fatalf("WA without a checker message: %+v", out.Tests[0])
				}
			})
		}
	}
}

func TestRESignalName(t *testing.T) {
	e := setup(t)
	t.Run("FR-JUDGE-05: a C segfault is RE with SIGSEGV", func(t *testing.T) {
		out := e.judge(t, Request{Language: "c", Source: programs["c"]["RE"], Limits: limits,
			Checker: contracts.Checker{Kind: contracts.CheckerKindTokens}, Tests: sumTests()})
		if out.Verdict != "RE" || out.Tests[0].Signal == nil || *out.Tests[0].Signal != "SIGSEGV" {
			t.Fatalf("%+v", out.Tests)
		}
	})
}

func TestStopOnFirstFailure(t *testing.T) {
	e := setup(t)
	tests := []Test{
		{No: 1, In: []byte("1 2\n"), Ans: []byte("3\n")},
		{No: 2, In: []byte("1 2\n"), Ans: []byte("4\n")}, // wrong on purpose
		{No: 3, In: []byte("5 5\n"), Ans: []byte("10\n")},
	}
	req := Request{Language: "c", Source: programs["c"]["AC"], Limits: limits,
		Checker: contracts.Checker{Kind: contracts.CheckerKindTokens}, Tests: tests}
	t.Run("FR-JUDGE-07: stops at the first failing test when asked", func(t *testing.T) {
		req := req
		req.StopOnFirstFailure = true
		out := e.judge(t, req)
		if out.Verdict != "WA" || len(out.Tests) != 2 || out.Tests[1].No != 2 {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("FR-JUDGE-07: runs every test otherwise, verdict is the first failure", func(t *testing.T) {
		out := e.judge(t, req)
		if out.Verdict != "WA" || len(out.Tests) != 3 || out.Tests[2].Verdict != "AC" {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("progress is reported per phase and per test", func(t *testing.T) {
		slot, _ := e.pool.Acquire(e.ctx)
		defer func() { _ = e.pool.Release(e.ctx, slot) }()
		var phases []contracts.JudgePhase
		var seen int
		_, err := e.eng.Run(e.ctx, slot, req, func(p contracts.JudgePhase, to *contracts.TestOutcome) {
			phases = append(phases, p)
			if to != nil {
				seen++
			}
		})
		if err != nil || seen != 3 || phases[0] != contracts.JudgePhaseCompiling || phases[1] != contracts.JudgePhaseRunning {
			t.Fatalf("%v %d %v", phases, seen, err)
		}
	})
}

func TestTestlibCheckers(t *testing.T) {
	e := setup(t)
	run := func(t *testing.T, file, program string) *Outcome {
		t.Helper()
		bin, err := e.checkerBinary(t, file)
		if err != nil {
			t.Fatal(err)
		}
		return e.judge(t, Request{Language: "c", Source: program, Limits: limits,
			Checker: contracts.Checker{Kind: contracts.CheckerKindTestlib}, CheckerBinary: bin, Tests: sumTests()})
	}
	t.Run("FR-JUDGE-06: a testlib checker (ncmp) accepts and rejects in a box", func(t *testing.T) {
		if out := run(t, "chk_ncmp.cpp", programs["c"]["AC"]); out.Verdict != "AC" {
			t.Fatalf("%+v", out)
		}
		out := run(t, "chk_ncmp.cpp", programs["c"]["WA"])
		if out.Verdict != "WA" || out.Tests[0].CheckerMsg == nil || !strings.Contains(*out.Tests[0].CheckerMsg, "expected 3, found 4") {
			t.Fatalf("%+v", out.Tests)
		}
	})
	t.Run("FR-JUDGE-06: _pe is merged into WA", func(t *testing.T) {
		out := run(t, "chk_pe.cpp", programs["c"]["AC"])
		if out.Verdict != "WA" || out.JuryError != "" {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("FR-JUDGE-06: partial credit counts as WA (NG2)", func(t *testing.T) {
		if out := run(t, "chk_points.cpp", programs["c"]["AC"]); out.Verdict != "WA" {
			t.Fatalf("%+v", out)
		}
	})
	for file, why := range map[string]string{"chk_fail.cpp": "jury answer is broken", "chk_crash.cpp": "killed", "chk_spin.cpp": "killed"} {
		t.Run("FR-JUDGE-06: "+file+" is SE with a jury alert", func(t *testing.T) {
			out := run(t, file, programs["c"]["AC"])
			if out.Verdict != "SE" || !strings.Contains(out.JuryError, why) && file != "chk_crash.cpp" {
				t.Fatalf("%+v", out)
			}
			if out.JuryError == "" {
				t.Fatal("no jury error to alert on")
			}
		})
	}
	t.Run("FR-JUDGE-06: a checker that does not compile is a jury error", func(t *testing.T) {
		if _, err := e.checkerBinary(t, "chk_broken.cpp"); !errors.Is(err, ErrCheckerCompile) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("FR-JUDGE-06: a testlib problem without a binary is SE", func(t *testing.T) {
		out := e.judge(t, Request{Language: "c", Source: programs["c"]["AC"], Limits: limits,
			Checker: contracts.Checker{Kind: contracts.CheckerKindTestlib}, Tests: sumTests()})
		if out.Verdict != "SE" || out.JuryError == "" {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("FR-JUDGE-06: a jury error stops judging even without stopOnFirstFailure", func(t *testing.T) {
		bin, err := e.checkerBinary(t, "chk_fail.cpp")
		if err != nil {
			t.Fatal(err)
		}
		tests := append(sumTests(), Test{No: 2, In: []byte("1 2\n"), Ans: []byte("3\n")})
		out := e.judge(t, Request{Language: "c", Source: programs["c"]["AC"], Limits: limits,
			Checker: contracts.Checker{Kind: contracts.CheckerKindTestlib}, CheckerBinary: bin, Tests: tests})
		if out.Verdict != "SE" || len(out.Tests) != 1 {
			t.Fatalf("%+v", out)
		}
	})
}

func TestEngineEdges(t *testing.T) {
	e := setup(t)
	t.Run("unknown language is an error, not a verdict", func(t *testing.T) {
		slot, _ := e.pool.Acquire(e.ctx)
		defer func() { _ = e.pool.Release(e.ctx, slot) }()
		if _, err := e.eng.Run(e.ctx, slot, Request{Language: "ruby", Tests: sumTests()}, nil); !errors.Is(err, ErrUnknownLanguage) {
			t.Fatalf("got %v", err)
		}
		if _, err := e.eng.Run(e.ctx, slot, Request{Language: "c"}, nil); err == nil {
			t.Fatal("no tests accepted")
		}
	})
	t.Run("FR-JUDGE-02: oversize source is CE", func(t *testing.T) {
		out := e.judge(t, Request{Language: "c", Source: strings.Repeat("a", languages.MaxSourceBytes+1), Limits: limits,
			Checker: contracts.Checker{Kind: contracts.CheckerKindTokens}, Tests: sumTests()})
		if out.Verdict != "CE" || !strings.Contains(out.CompileLog, "64 KB") {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("FR-JUDGE-08: a program that swaps its output file for a symlink gets no free pass", func(t *testing.T) {
		src := `#include <unistd.h>` + "\n" + `#include <stdio.h>` + "\n" + `int main(){unlink("out.txt");symlink("/etc/passwd","out.txt");return 0;}`
		out := e.judge(t, Request{Language: "c", Source: src, Limits: limits,
			Checker: contracts.Checker{Kind: contracts.CheckerKindTokens}, Tests: sumTests()})
		if out.Verdict != "WA" {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("each test starts in a fresh box: files left by one run are gone in the next", func(t *testing.T) {
		src := `#include <stdio.h>` + "\n" + `int main(){FILE*f=fopen("state","r");if(f){puts("leak");return 0;}f=fopen("state","w");fputs("x",f);fclose(f);puts("3");return 0;}`
		tests := []Test{{No: 1, In: []byte("\n"), Ans: []byte("3\n")}, {No: 2, In: []byte("\n"), Ans: []byte("3\n")}}
		out := e.judge(t, Request{Language: "c", Source: src, Limits: limits,
			Checker: contracts.Checker{Kind: contracts.CheckerKindTokens}, Tests: tests})
		if out.Verdict != "AC" {
			t.Fatalf("%+v", out.Tests)
		}
	})
}

func TestRunCustom(t *testing.T) {
	e := setup(t)
	run := func(t *testing.T, lang contracts.Language, src, input string, lim contracts.Limits) *Outcome {
		t.Helper()
		slot, err := e.pool.Acquire(e.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = e.pool.Release(e.ctx, slot) }()
		out, err := e.eng.RunCustom(e.ctx, slot, CustomRequest{Language: lang, Source: src, Limits: lim, Input: []byte(input)}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	bigOut := contracts.Limits{TimeMS: 500, MemMB: 128, OutputKB: 1024}

	t.Run("FR-SUB-05: returns stdout and stderr, verdict AC means it ran to completion", func(t *testing.T) {
		src := `#include <stdio.h>` + "\n" + `int main(){long a,b;scanf("%ld %ld",&a,&b);printf("%ld\n",a+b);fprintf(stderr,"note\n");return 0;}`
		out := run(t, "c", src, "40 2\n", limits)
		if out.Verdict != "AC" || out.Output == nil || *out.Output != "42\n" || out.Stderr == nil || *out.Stderr != "note\n" ||
			len(out.Tests) != 1 || out.MemKB <= 0 {
			t.Fatalf("%+v out=%v", out, out.Output)
		}
	})
	t.Run("FR-SUB-05: a wrong-looking answer is still AC: there is nothing to compare with", func(t *testing.T) {
		out := run(t, "python3", "print('anything')\n", "", limits)
		if out.Verdict != "AC" || *out.Output != "anything\n" {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("FR-SUB-05: a crash is RE with the signal and whatever it printed before", func(t *testing.T) {
		src := `#include <stdio.h>` + "\n" + `int main(){puts("before");fflush(stdout);volatile int*p=0;*p=1;return 0;}`
		out := run(t, "c", src, "", limits)
		if out.Verdict != "RE" || out.Tests[0].Signal == nil || *out.Tests[0].Signal != "SIGSEGV" || *out.Output != "before\n" {
			t.Fatalf("%+v out=%q", out, *out.Output)
		}
	})
	t.Run("FR-SUB-05: TLE and CE are reported like for judged runs", func(t *testing.T) {
		if out := run(t, "c", programs["c"]["TLE"], "", limits); out.Verdict != "TLE" {
			t.Fatalf("%+v", out)
		}
		out := run(t, "c", programs["c"]["CE"], "", limits)
		if out.Verdict != "CE" || out.CompileLog == "" || out.Output != nil {
			t.Fatalf("%+v", out)
		}
	})
	t.Run("FR-SUB-05: output over the problem's output limit is OLE, and the first 64 KB still come back", func(t *testing.T) {
		out := run(t, "c", programs["c"]["OLE"], "", limits) // 8 MB against a 64 KB limit
		if out.Verdict != "OLE" || len(*out.Output) == 0 || len(*out.Output) > MaxCustomOutput {
			t.Fatalf("%s %d bytes", out.Verdict, len(*out.Output))
		}
	})
	t.Run("FR-SUB-05: output is cut at 64 KB", func(t *testing.T) {
		src := `#include <stdio.h>` + "\n" + `int main(){for(int i=0;i<20000;i++)puts("0123456789012345678901234567890123456789");return 0;}` // 820 KB
		out := run(t, "c", src, "", bigOut)
		if out.Verdict != "AC" || len(*out.Output) != MaxCustomOutput {
			t.Fatalf("%s %d bytes", out.Verdict, len(*out.Output))
		}
	})
	t.Run("FR-SUB-05: binary output becomes valid UTF-8 so the result stays valid JSON", func(t *testing.T) {
		src := `#include <stdio.h>` + "\n" + `int main(){fwrite("ok\xff\xfe\n",1,5,stdout);return 0;}`
		out := run(t, "c", src, "", limits)
		b, err := json.Marshal(out.Output)
		if err != nil || !utf8.ValidString(*out.Output) || !strings.HasPrefix(*out.Output, "ok") {
			t.Fatalf("%q %v", *out.Output, err)
		}
		_ = b
	})
	t.Run("an unknown language is an error", func(t *testing.T) {
		slot, _ := e.pool.Acquire(e.ctx)
		defer func() { _ = e.pool.Release(e.ctx, slot) }()
		if _, err := e.eng.RunCustom(e.ctx, slot, CustomRequest{Language: "ruby"}, nil); !errors.Is(err, ErrUnknownLanguage) {
			t.Fatalf("got %v", err)
		}
	})
}
