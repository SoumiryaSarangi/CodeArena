// Package judge turns sandbox runs into verdicts: SD-§8.4 mapping, the
// exact/tokens/float/testlib checkers (SD-§8.5) and the per-submission
// pipeline (SD-§8.1).
package judge

import (
	"strings"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/sandbox"
)

// RunInfo is what the verdict mapping needs to know about one program run.
type RunInfo struct {
	Meta sandbox.Meta
	// OutputBytes is the size of the program's output file; OutputLimit the
	// problem's limit in bytes. The sandbox file-size limit is one KB above
	// OutputLimit, so output larger than the limit is exactly "hit the cap".
	OutputBytes int64
	OutputLimit int64
	// Stderr is the start of the program's stderr, used only for the
	// language's out-of-memory markers.
	Stderr     string
	OOMMarkers []string
}

// MapRun applies SD-§8.4 to a run that has not been checked yet. ok is true
// when the run completed cleanly and the output should go to the checker.
// signal is the terminating signal name for an RE.
func MapRun(r RunInfo) (v contracts.Verdict, signal string, ok bool) {
	m := r.Meta
	switch {
	case m.Status == sandbox.StatusInternal:
		return contracts.VerdictSE, "", false
	case m.Status == sandbox.StatusTO:
		return contracts.VerdictTLE, "", false
	case m.OOMKilled:
		return contracts.VerdictMLE, "", false
	case m.ExitSig == 25 /* SIGXFSZ */ || r.OutputBytes > r.OutputLimit:
		// Checked before RE: Python, Java and Node ignore SIGXFSZ, fail the
		// write with EFBIG and exit non-zero, which must still be OLE.
		return contracts.VerdictOLE, "", false
	case m.Status == sandbox.StatusRE || m.Status == sandbox.StatusSG:
		for _, marker := range r.OOMMarkers {
			if strings.Contains(r.Stderr, marker) {
				return contracts.VerdictMLE, "", false
			}
		}
		return contracts.VerdictRE, m.Signal(), false
	}
	return contracts.VerdictAC, "", true
}

// MapChecker applies the checker rows of SD-§8.4. A jury error (_fail, or a
// checker that crashed or timed out) is SE and must raise an alert.
func MapChecker(res CheckResult) contracts.Verdict {
	switch res.Status {
	case CheckOK:
		return contracts.VerdictAC
	case CheckWA, CheckPE:
		// Presentation errors are merged into WA, like Codeforces.
		return contracts.VerdictWA
	}
	return contracts.VerdictSE
}
