package judge

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/languages"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

// testlibH is the vendored testlib.h (MIT, see testlib/LICENSE). It is written
// next to a checker's source when the checker is compiled.
//
//go:embed testlib/testlib.h
var testlibH []byte

// Checker limits: generous, because a checker that cannot finish is a jury
// error, not a contestant's problem.
const (
	checkerCPU     = 5 * time.Second
	checkerMemKB   = 256 << 10
	checkerFsizeKB = 1024
)

// ErrCheckerCompile means a testlib checker did not compile: a jury error.
var ErrCheckerCompile = errors.New("judge: checker failed to compile")

// CompileChecker builds a testlib checker (C++17) in the compile box and
// returns the binary. Callers cache it by hash per problem version (J-04/J-05).
func CompileChecker(ctx context.Context, reg *languages.Registry, box *sandbox.Box, source string) ([]byte, error) {
	l, ok := reg.Get(contracts.LanguageCpp17)
	if !ok {
		return nil, errors.New("judge: cpp17 is not in the registry")
	}
	res, err := reg.CompileWith(ctx, box, l, source, []languages.File{{Name: "testlib.h", Data: testlibH}})
	if err != nil {
		return nil, err
	}
	if !res.OK || len(res.Artifacts) != 1 {
		return nil, fmt.Errorf("%w: %s", ErrCheckerCompile, res.Log)
	}
	return res.Artifacts[0].Data, nil
}

// testlib exit codes (SD-§8.4). _pc(x) exits with 50+x, which is partial
// credit and is out of scope (NG2), so it counts as WA.
const (
	tlOK   = 0
	tlWA   = 1
	tlPE   = 2
	tlFail = 3
	tlPCLo = 50
	tlPCHi = 150
)

// RunTestlib runs a compiled testlib checker as `checker input output answer`
// in the checker box (FR-JUDGE-06). Anything but a clean 0/1/2 (or partial
// credit) is a jury error: a crash, a time-out and _fail all become CheckFail.
func RunTestlib(ctx context.Context, box *sandbox.Box, binary, in, out, ans []byte) (CheckResult, error) {
	if err := box.Init(ctx); err != nil {
		return CheckResult{}, err
	}
	for _, f := range []struct {
		name string
		data []byte
		perm uint32
	}{{"checker", binary, 0o755}, {"in.txt", in, 0o644}, {"out.txt", out, 0o644}, {"ans.txt", ans, 0o644}} {
		if err := box.WriteFile(f.name, f.data, os.FileMode(f.perm)); err != nil {
			return CheckResult{}, fmt.Errorf("judge: checker box: %w", err)
		}
	}
	meta, err := box.Run(ctx, sandbox.RunSpec{
		TimeLimit: checkerCPU,
		MemKB:     checkerMemKB,
		Processes: 1,
		FsizeKB:   checkerFsizeKB,
		Stdout:    "stdout.txt",
		Stderr:    "stderr.txt",
		Cmd:       []string{"./checker", "in.txt", "out.txt", "ans.txt"},
	})
	if err != nil {
		return CheckResult{}, err
	}
	msg := ""
	if data, _, err := box.ReadFile("stderr.txt", 1024); err == nil {
		msg = clip(strings.TrimSpace(string(data)))
	}
	fail := func(why string) CheckResult {
		if msg != "" {
			why += ": " + msg
		}
		return CheckResult{Status: CheckFail, Msg: clip(why)}
	}
	switch {
	case meta.Status == sandbox.StatusOK:
		return CheckResult{Status: CheckOK}, nil
	case meta.Status != sandbox.StatusRE:
		return fail("checker was killed (" + string(meta.Status) + ")"), nil
	case meta.ExitCode == tlWA, meta.ExitCode == tlPE:
		return CheckResult{Status: CheckStatus(meta.ExitCode), Msg: msg}, nil
	case meta.ExitCode == tlFail:
		return fail("checker failed"), nil
	case meta.ExitCode >= tlPCLo && meta.ExitCode <= tlPCHi:
		return CheckResult{Status: CheckWA, Msg: msg}, nil
	}
	return fail(fmt.Sprintf("checker exited with code %d", meta.ExitCode)), nil
}
