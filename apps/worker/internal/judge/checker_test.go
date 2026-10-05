package judge

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

func TestCheckExact(t *testing.T) {
	cases := []struct {
		name     string
		out, ans string
		want     CheckStatus
	}{
		{"identical", "1 2 3\nabc\n", "1 2 3\nabc\n", CheckOK},
		{"missing final newline", "1 2 3\nabc", "1 2 3\nabc\n", CheckOK},
		{"extra final newline is not blank-line tolerance", "a\n\n", "a\n", CheckWA},
		{"trailing spaces and tabs at line ends", "a  \t\nb \n", "a\nb\n", CheckOK},
		{"CRLF line endings", "a\r\nb\r\n", "a\nb\n", CheckOK},
		{"leading whitespace matters", " a\n", "a\n", CheckWA},
		{"inner whitespace matters", "a  b\n", "a b\n", CheckWA},
		{"blank line in the middle matters", "a\n\nb\n", "a\nb\n", CheckWA},
		{"different content", "a\nx\n", "a\ny\n", CheckWA},
		{"output too short", "a\n", "a\nb\n", CheckWA},
		{"output too long", "a\nb\n", "a\n", CheckWA},
		{"empty equals empty", "", "", CheckOK},
		{"empty versus newline", "", "\n", CheckOK},
		{"empty versus text", "", "x\n", CheckWA},
	}
	for _, c := range cases {
		t.Run("FR-JUDGE-06: exact "+c.name, func(t *testing.T) {
			if got := CheckExact([]byte(c.out), []byte(c.ans)); got.Status != c.want {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestCheckTokens(t *testing.T) {
	cases := []struct {
		name     string
		out, ans string
		want     CheckStatus
	}{
		{"whitespace layout ignored", "1   2\n\n3", "1 2 3\n", CheckOK},
		{"tabs and CRs", "1\t2\r\n3", "1 2 3", CheckOK},
		{"different token", "1 2 4", "1 2 3", CheckWA},
		{"too few tokens", "1 2", "1 2 3", CheckWA},
		{"too many tokens", "1 2 3 4", "1 2 3", CheckWA},
		{"case matters", "Yes", "YES", CheckWA},
		{"numbers are compared as text", "1.0", "1", CheckWA},
		{"both empty", "  \n", "", CheckOK},
	}
	for _, c := range cases {
		t.Run("FR-JUDGE-06: tokens "+c.name, func(t *testing.T) {
			if got := CheckTokens([]byte(c.out), []byte(c.ans)); got.Status != c.want {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestCheckFloat(t *testing.T) {
	cases := []struct {
		name     string
		out, ans string
		eps      float64
		want     CheckStatus
	}{
		{"within absolute error", "0.3000004", "0.3", 1e-6, CheckOK},
		{"outside absolute error", "0.3000100", "0.3", 1e-6, CheckWA},
		{"relative error for large values", "1000000.4", "1000000", 1e-6, CheckOK},
		{"relative error exceeded", "1000002", "1000000", 1e-6, CheckWA},
		{"exact boundary accepted", "1.5", "1", 0.5, CheckOK},
		{"integers and decimals mix", "3", "3.0000001", 1e-6, CheckOK},
		{"non-numeric tokens must be equal", "YES 1.0", "YES 1.0000001", 1e-6, CheckOK},
		{"non-numeric mismatch", "YES", "NO", 1e-6, CheckWA},
		{"identical NaN tokens are byte-equal", "nan", "nan", 1e-6, CheckOK},
		{"NaN against a number", "nan", "1", 1e6, CheckWA},
		{"infinity equals itself only", "inf", "inf", 1e-6, CheckOK},
		{"infinity against a number", "inf", "1e308", 1e300, CheckWA},
		{"token count differs", "1 2", "1", 1e-6, CheckWA},
		{"scientific notation", "1e-3", "0.001", 1e-9, CheckOK},
		{"negative eps is a jury error", "1", "1", -1, CheckFail},
	}
	for _, c := range cases {
		t.Run("FR-JUDGE-06: float "+c.name, func(t *testing.T) {
			if got := CheckFloat([]byte(c.out), []byte(c.ans), c.eps); got.Status != c.want {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestCheckDispatchAndMessages(t *testing.T) {
	eps := 1e-6
	t.Run("FR-JUDGE-06: Check dispatches by kind", func(t *testing.T) {
		if Check(contracts.Checker{Kind: contracts.CheckerKindTokens}, []byte("1  2"), []byte("1 2")).Status != CheckOK {
			t.Fatal("tokens")
		}
		if Check(contracts.Checker{Kind: contracts.CheckerKindExact}, []byte("1  2"), []byte("1 2")).Status != CheckWA {
			t.Fatal("exact")
		}
		if Check(contracts.Checker{Kind: contracts.CheckerKindFloat, Eps: &eps}, []byte("1.0000001"), []byte("1")).Status != CheckOK {
			t.Fatal("float")
		}
	})
	t.Run("FR-JUDGE-06: float without eps and unknown kinds are jury errors", func(t *testing.T) {
		if Check(contracts.Checker{Kind: contracts.CheckerKindFloat}, nil, nil).Status != CheckFail {
			t.Fatal("float without eps")
		}
		if Check(contracts.Checker{Kind: contracts.CheckerKindTestlib}, nil, nil).Status != CheckFail {
			t.Fatal("testlib is not a built-in")
		}
	})
	t.Run("FR-JUDGE-06: messages say where the mismatch is and stay under 256 chars", func(t *testing.T) {
		got := CheckTokens([]byte("1 2 9"), []byte("1 2 3"))
		if !strings.Contains(got.Msg, "token 3") || !strings.Contains(got.Msg, `"3"`) || !strings.Contains(got.Msg, `"9"`) {
			t.Fatalf("%q", got.Msg)
		}
		long := strings.Repeat("é", 1000)
		got = CheckExact([]byte(long), []byte("x"))
		if n := utf8.RuneCountInString(got.Msg); n == 0 || n > MaxCheckerMsg || !utf8.ValidString(got.Msg) {
			t.Fatalf("%d runes valid=%v", n, utf8.ValidString(got.Msg))
		}
		if n := utf8.RuneCountInString(clip(strings.Repeat("é", 300))); n != MaxCheckerMsg {
			t.Fatalf("clip gave %d runes", n)
		}
	})
}
