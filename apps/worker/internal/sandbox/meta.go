package sandbox

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// MaxMetaBytes caps the meta file; real ones are a few hundred bytes.
const MaxMetaBytes = 64 << 10

// ErrBadMeta is wrapped by every meta parsing error.
var ErrBadMeta = errors.New("sandbox: malformed meta file")

// Status is isolate's meta "status" field. Empty means the program exited 0.
type Status string

const (
	StatusOK       Status = ""
	StatusRE       Status = "RE" // non-zero exit
	StatusSG       Status = "SG" // killed by a signal
	StatusTO       Status = "TO" // CPU or wall time exceeded
	StatusInternal Status = "XX" // sandbox internal error
)

// Meta is a parsed isolate meta file.
type Meta struct {
	Status       Status
	Message      string
	TimeMS       int64 // CPU time of the whole cgroup
	WallMS       int64
	MaxRSSKB     int64
	CgMemKB      int64 // peak memory of the whole cgroup
	OOMKilled    bool
	ExitCode     int
	ExitSig      int
	Killed       bool
	CswVoluntary int64
	CswForced    int64
}

// ParseMeta reads isolate's "key:value" lines. Unknown keys are ignored so a
// newer isolate does not break the judge; anything malformed is an error.
func ParseMeta(r io.Reader) (Meta, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxMetaBytes+1))
	if err != nil {
		return Meta{}, err
	}
	if len(data) > MaxMetaBytes {
		return Meta{}, fmt.Errorf("%w: larger than %d bytes", ErrBadMeta, MaxMetaBytes)
	}
	var m Meta
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 4096), MaxMetaBytes)
	for line := 1; sc.Scan(); line++ {
		text := sc.Text()
		if text == "" {
			continue
		}
		key, val, ok := strings.Cut(text, ":")
		if !ok || key == "" {
			return Meta{}, fmt.Errorf("%w: line %d has no key", ErrBadMeta, line)
		}
		if err := m.set(key, val); err != nil {
			return Meta{}, fmt.Errorf("%w: line %d (%s): %v", ErrBadMeta, line, key, err)
		}
	}
	if err := sc.Err(); err != nil {
		return Meta{}, fmt.Errorf("%w: %v", ErrBadMeta, err)
	}
	return m, nil
}

func (m *Meta) set(key, val string) error {
	var err error
	switch key {
	case "status":
		switch s := Status(val); s {
		case StatusRE, StatusSG, StatusTO, StatusInternal:
			m.Status = s
		default:
			return fmt.Errorf("unknown status %q", val)
		}
	case "message":
		m.Message = val
	case "time":
		m.TimeMS, err = parseSeconds(val)
	case "time-wall":
		m.WallMS, err = parseSeconds(val)
	case "max-rss":
		m.MaxRSSKB, err = parseCount(val)
	case "cg-mem":
		m.CgMemKB, err = parseCount(val)
	case "cg-oom-killed":
		m.OOMKilled, err = parseFlag(val)
	case "killed":
		m.Killed, err = parseFlag(val)
	case "exitcode":
		m.ExitCode, err = parseSmall(val)
	case "exitsig":
		m.ExitSig, err = parseSmall(val)
	case "csw-voluntary":
		m.CswVoluntary, err = parseCount(val)
	case "csw-forced":
		m.CswForced, err = parseCount(val)
	}
	return err
}

func parseSeconds(v string) (int64, error) {
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 1e6 {
		return 0, fmt.Errorf("bad seconds %q", v)
	}
	return int64(math.Round(f * 1000)), nil
}

func parseCount(v string) (int64, error) {
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("bad count %q", v)
	}
	return n, nil
}

func parseSmall(v string) (int, error) {
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 || n > 255 {
		return 0, fmt.Errorf("bad code %q", v)
	}
	return n, nil
}

func parseFlag(v string) (bool, error) {
	if v != "1" {
		return false, fmt.Errorf("bad flag %q", v)
	}
	return true, nil
}

var signalNames = [...]string{
	1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT",
	7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGUSR1", 11: "SIGSEGV", 12: "SIGUSR2",
	13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 16: "SIGSTKFLT", 17: "SIGCHLD",
	18: "SIGCONT", 19: "SIGSTOP", 20: "SIGTSTP", 21: "SIGTTIN", 22: "SIGTTOU",
	23: "SIGURG", 24: "SIGXCPU", 25: "SIGXFSZ", 26: "SIGVTALRM", 27: "SIGPROF",
	28: "SIGWINCH", 29: "SIGIO", 30: "SIGPWR", 31: "SIGSYS",
}

// Signal is the name of the terminating signal ("SIGSEGV"), or "" if none.
func (m Meta) Signal() string {
	if m.ExitSig <= 0 {
		return ""
	}
	if m.ExitSig < len(signalNames) {
		return signalNames[m.ExitSig]
	}
	return "SIG" + strconv.Itoa(m.ExitSig)
}
