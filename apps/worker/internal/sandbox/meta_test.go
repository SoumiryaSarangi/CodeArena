package sandbox

import (
	"errors"
	"strings"
	"testing"
)

func TestParseMeta(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want Meta
	}{
		{
			name: "ok",
			in:   "time:0.010\ntime-wall:0.012\nmax-rss:1344\ncsw-voluntary:5\ncsw-forced:2\ncg-mem:360\nexitcode:0\n",
			want: Meta{TimeMS: 10, WallMS: 12, MaxRSSKB: 1344, CswVoluntary: 5, CswForced: 2, CgMemKB: 360},
		},
		{
			name: "non-zero exit",
			in:   "status:RE\nmessage:Exited with error status 3\nexitcode:3\ntime:0.001\n",
			want: Meta{Status: StatusRE, Message: "Exited with error status 3", ExitCode: 3, TimeMS: 1},
		},
		{
			name: "signal",
			in:   "status:SG\nexitsig:11\nmessage:Caught fatal signal 11\n",
			want: Meta{Status: StatusSG, ExitSig: 11, Message: "Caught fatal signal 11"},
		},
		{
			name: "cpu timeout",
			in:   "status:TO\nmessage:Time limit exceeded\nkilled:1\ntime:1.503\ntime-wall:1.510\n",
			want: Meta{Status: StatusTO, Message: "Time limit exceeded", Killed: true, TimeMS: 1503, WallMS: 1510},
		},
		{
			name: "wall timeout",
			in:   "status:TO\nmessage:Time limit exceeded (wall clock)\nkilled:1\ntime:0.000\ntime-wall:4.000\n",
			want: Meta{Status: StatusTO, Message: "Time limit exceeded (wall clock)", Killed: true, WallMS: 4000},
		},
		{
			name: "oom",
			in:   "status:SG\nexitsig:9\ncg-oom-killed:1\ncg-mem:65536\n",
			want: Meta{Status: StatusSG, ExitSig: 9, OOMKilled: true, CgMemKB: 65536},
		},
		{
			name: "internal error",
			in:   "status:XX\nmessage:Cannot run proxy\n",
			want: Meta{Status: StatusInternal, Message: "Cannot run proxy"},
		},
		{
			name: "message keeps colons, unknown keys ignored, blank lines skipped",
			in:   "message:a:b:c\n\ncg-enabled:1\nsome-future-key:x\n",
			want: Meta{Message: "a:b:c"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ParseMeta(strings.NewReader(c.in))
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("\n got %+v\nwant %+v", got, c.want)
			}
		})
	}
}

func TestParseMetaRejects(t *testing.T) {
	cases := map[string]string{
		"no colon":          "time 0.1\n",
		"empty key":         ":1\n",
		"unknown status":    "status:OK\n",
		"bad seconds":       "time:abc\n",
		"negative seconds":  "time:-1\n",
		"nan seconds":       "time:NaN\n",
		"inf seconds":       "time-wall:+Inf\n",
		"huge seconds":      "time:1e300\n",
		"bad count":         "cg-mem:12KB\n",
		"negative count":    "max-rss:-5\n",
		"exit out of range": "exitcode:256\n",
		"bad flag":          "cg-oom-killed:yes\n",
		"oversize":          strings.Repeat("x:y\n", MaxMetaBytes/4+1),
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseMeta(strings.NewReader(in)); !errors.Is(err, ErrBadMeta) {
				t.Fatalf("want ErrBadMeta, got %v", err)
			}
		})
	}
}

func TestMetaSignal(t *testing.T) {
	for sig, want := range map[int]string{0: "", 11: "SIGSEGV", 25: "SIGXFSZ", 9: "SIGKILL", 40: "SIG40"} {
		if got := (Meta{ExitSig: sig}).Signal(); got != want {
			t.Errorf("signal %d: got %q want %q", sig, got, want)
		}
	}
}
