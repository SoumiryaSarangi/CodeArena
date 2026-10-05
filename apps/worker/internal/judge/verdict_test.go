package judge

import (
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

func TestMapRun(t *testing.T) {
	const limit = 1 << 20
	cases := []struct {
		name   string
		info   RunInfo
		want   contracts.Verdict
		signal string
		clean  bool
	}{
		{"exit 0 goes to the checker", RunInfo{}, contracts.VerdictAC, "", true},
		{"status TO (CPU) is TLE", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusTO, Message: "Time limit exceeded"}}, contracts.VerdictTLE, "", false},
		{"status TO (wall) is TLE", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusTO, Message: "Time limit exceeded (wall clock)"}}, contracts.VerdictTLE, "", false},
		{"cg-oom-killed is MLE, even though status is SG/9", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusSG, ExitSig: 9, OOMKilled: true}}, contracts.VerdictMLE, "", false},
		{"SIGXFSZ is OLE", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusSG, ExitSig: 25}}, contracts.VerdictOLE, "", false},
		{"output over the limit is OLE even if the runtime swallowed SIGXFSZ", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusRE, ExitCode: 1}, OutputBytes: limit + 1}, contracts.VerdictOLE, "", false},
		{"output exactly at the limit is fine", RunInfo{OutputBytes: limit}, contracts.VerdictAC, "", true},
		{"signal is RE with its name", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusSG, ExitSig: 11}}, contracts.VerdictRE, "SIGSEGV", false},
		{"non-zero exit is RE", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusRE, ExitCode: 3}}, contracts.VerdictRE, "", false},
		{"sandbox internal error is SE", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusInternal}}, contracts.VerdictSE, "", false},
		{"TLE beats MLE beats OLE beats RE", RunInfo{Meta: sandbox.Meta{Status: sandbox.StatusTO, OOMKilled: true, ExitSig: 25}}, contracts.VerdictTLE, "", false},
		{"JVM OutOfMemoryError is MLE", RunInfo{
			Meta:       sandbox.Meta{Status: sandbox.StatusRE, ExitCode: 1},
			Stderr:     "Exception in thread \"main\" java.lang.OutOfMemoryError: Java heap space",
			OOMMarkers: []string{"java.lang.OutOfMemoryError"}}, contracts.VerdictMLE, "", false},
		{"the marker only counts when the language declares it", RunInfo{
			Meta:   sandbox.Meta{Status: sandbox.StatusRE, ExitCode: 1},
			Stderr: "java.lang.OutOfMemoryError"}, contracts.VerdictRE, "", false},
	}
	for _, c := range cases {
		t.Run("FR-JUDGE-05: "+c.name, func(t *testing.T) {
			c.info.OutputLimit = limit
			v, sig, clean := MapRun(c.info)
			if v != c.want || sig != c.signal || clean != c.clean {
				t.Fatalf("got %s %q %v, want %s %q %v", v, sig, clean, c.want, c.signal, c.clean)
			}
		})
	}
}

func TestMapChecker(t *testing.T) {
	for status, want := range map[CheckStatus]contracts.Verdict{
		CheckOK: contracts.VerdictAC, CheckWA: contracts.VerdictWA, CheckPE: contracts.VerdictWA, CheckFail: contracts.VerdictSE,
	} {
		t.Run("FR-JUDGE-05/06: checker status to verdict", func(t *testing.T) {
			if got := MapChecker(CheckResult{Status: status}); got != want {
				t.Fatalf("%d: got %s want %s", status, got, want)
			}
		})
	}
}
