package judge

import (
	"bytes"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

// MaxCheckerMsg is the longest checker message kept (SD-§8.5).
const MaxCheckerMsg = 256

// CheckStatus is a checker outcome; the values follow testlib exit codes.
type CheckStatus int

const (
	CheckOK   CheckStatus = 0 // _ok
	CheckWA   CheckStatus = 1 // _wa
	CheckPE   CheckStatus = 2 // _pe, merged into WA
	CheckFail CheckStatus = 3 // _fail: jury error, becomes SE and an alert
)

// CheckResult is what a checker decided about one test.
type CheckResult struct {
	Status CheckStatus
	Msg    string
}

func wa(format string, args ...any) CheckResult {
	return CheckResult{Status: CheckWA, Msg: clip(fmt.Sprintf(format, args...))}
}

var ok = CheckResult{Status: CheckOK}

// clip bounds a checker message to MaxCheckerMsg characters of valid UTF-8.
func clip(s string) string {
	s = strings.ToValidUTF8(s, "�")
	if utf8.RuneCountInString(s) <= MaxCheckerMsg {
		return s
	}
	r := []rune(s)
	return string(r[:MaxCheckerMsg-1]) + "…"
}

// show makes a token printable in a message.
func show(s string) string {
	if len(s) > 40 {
		s = s[:40] + "…"
	}
	return strconv.Quote(s)
}

// Check runs a built-in checker. testlib checkers run in a box instead
// (RunTestlib); asking for one here is a jury error.
func Check(c contracts.Checker, out, ans []byte) CheckResult {
	switch c.Kind {
	case contracts.CheckerKindExact:
		return CheckExact(out, ans)
	case contracts.CheckerKindTokens:
		return CheckTokens(out, ans)
	case contracts.CheckerKindFloat:
		if c.Eps == nil {
			return CheckResult{Status: CheckFail, Msg: "float checker without eps"}
		}
		return CheckFloat(out, ans, *c.Eps)
	}
	return CheckResult{Status: CheckFail, Msg: "unsupported checker kind " + string(c.Kind)}
}

// normalize trims trailing spaces, tabs and CRs from every line and removes
// one final newline. Extra blank lines are NOT ignored: "exact" is meant to
// be strict about everything except line-end whitespace and the last newline.
func normalize(b []byte) []byte {
	lines := bytes.Split(b, []byte("\n"))
	if n := len(lines); n > 0 && len(lines[n-1]) == 0 {
		lines = lines[:n-1]
	}
	for i, l := range lines {
		lines[i] = bytes.TrimRight(l, " \t\r")
	}
	return bytes.Join(lines, []byte("\n"))
}

// CheckExact is byte equality after normalize.
func CheckExact(out, ans []byte) CheckResult {
	a, b := normalize(out), normalize(ans)
	if bytes.Equal(a, b) {
		return ok
	}
	la, lb := bytes.Split(a, []byte("\n")), bytes.Split(b, []byte("\n"))
	for i := 0; i < len(la) || i < len(lb); i++ {
		switch {
		case i >= len(la):
			return wa("output ends at line %d, expected more", len(la))
		case i >= len(lb):
			return wa("extra output at line %d", i+1)
		case !bytes.Equal(la[i], lb[i]):
			return wa("line %d differs: expected %s, found %s", i+1, show(string(lb[i])), show(string(la[i])))
		}
	}
	return wa("outputs differ")
}

// fields splits on ASCII whitespace.
func fields(b []byte) []string {
	return strings.FieldsFunc(string(b), func(r rune) bool {
		return r == ' ' || r == '\n' || r == '\t' || r == '\r' || r == '\v' || r == '\f'
	})
}

// CheckTokens compares whitespace-separated tokens (the default checker).
func CheckTokens(out, ans []byte) CheckResult {
	return compareTokens(out, ans, func(got, want string) bool { return got == want })
}

// CheckFloat compares tokens; two numeric tokens match when
// |got-want| <= eps * max(1, |want|), which is an absolute error for small
// values and a relative error for large ones. NaN only matches an identical
// token, infinities must be equal, anything else must be byte-equal.
func CheckFloat(out, ans []byte, eps float64) CheckResult {
	if math.IsNaN(eps) || eps < 0 {
		return CheckResult{Status: CheckFail, Msg: "invalid eps"}
	}
	return compareTokens(out, ans, func(got, want string) bool {
		if got == want {
			return true
		}
		g, gerr := strconv.ParseFloat(got, 64)
		w, werr := strconv.ParseFloat(want, 64)
		if gerr != nil || werr != nil || math.IsNaN(g) || math.IsNaN(w) {
			return false
		}
		if math.IsInf(g, 0) || math.IsInf(w, 0) {
			return g == w
		}
		return math.Abs(g-w) <= eps*math.Max(1, math.Abs(w))
	})
}

func compareTokens(out, ans []byte, eq func(got, want string) bool) CheckResult {
	got, want := fields(out), fields(ans)
	for i := 0; i < len(got) && i < len(want); i++ {
		if !eq(got[i], want[i]) {
			return wa("token %d differs: expected %s, found %s", i+1, show(want[i]), show(got[i]))
		}
	}
	if len(got) != len(want) {
		return wa("output has %d tokens, expected %d", len(got), len(want))
	}
	return ok
}
