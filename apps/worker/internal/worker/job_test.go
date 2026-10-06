package worker

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/testcache"
)

const goodTrace = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

func validJob(id string) contracts.JudgeJob {
	return contracts.JudgeJob{
		JobID: "job-" + id, SubmissionID: "sub-" + id, RunVersion: 1, Lane: contracts.LanePractice,
		Language: contracts.LanguageC, Source: "int main(){}", Mode: contracts.JobModeSubmit,
		Problem: contracts.ProblemRef{
			VersionID: "pv-1", TestsetHash: strings.Repeat("a", 64), TestsetURI: "s3://codearena/testsets/a.tar",
			Checker: contracts.Checker{Kind: contracts.CheckerKindTokens},
			Limits:  contracts.Limits{TimeMS: 1000, MemMB: 256, OutputKB: 64},
		},
		StopOnFirstFailure: true, Traceparent: goodTrace, EnqueuedAt: 1, Seq: 1,
	}
}

func encode(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestParseJob(t *testing.T) {
	t.Run("a valid job round-trips", func(t *testing.T) {
		j, err := ParseJob(encode(t, validJob("1")))
		if err != nil || j.SubmissionID != "sub-1" || j.Problem.Limits.MemMB != 256 {
			t.Fatalf("%+v %v", j, err)
		}
	})
	mutate := func(f func(*contracts.JudgeJob)) string {
		j := validJob("1")
		f(&j)
		return encode(t, j)
	}
	eps := 1e-6
	zero := 0.0
	empty := ""
	bin := "s3://codearena/checkers/c.cpp"
	big := strings.Repeat("a", maxInputBytes+1)
	cases := map[string]string{
		"empty":                 "",
		"not json":              "{",
		"trailing data":         encode(t, validJob("1")) + " {}",
		"unknown field":         strings.Replace(encode(t, validJob("1")), `"seq":1`, `"seq":1,"admin":true`, 1),
		"missing job id":        mutate(func(j *contracts.JudgeJob) { j.JobID = "" }),
		"missing submission id": mutate(func(j *contracts.JudgeJob) { j.SubmissionID = "" }),
		"run version 0":         mutate(func(j *contracts.JudgeJob) { j.RunVersion = 0 }),
		"negative seq":          mutate(func(j *contracts.JudgeJob) { j.Seq = -1 }),
		"unknown lane":          mutate(func(j *contracts.JudgeJob) { j.Lane = "vip" }),
		"unknown mode":          mutate(func(j *contracts.JudgeJob) { j.Mode = "debug" }),
		"source over 64 KB":     mutate(func(j *contracts.JudgeJob) { j.Source = strings.Repeat("a", maxSourceBytes+1) }),
		"input over 1 MB":       mutate(func(j *contracts.JudgeJob) { j.CustomInput = &big }),
		"bad traceparent":       mutate(func(j *contracts.JudgeJob) { j.Traceparent = "00-xyz" }),
		"missing testset hash":  mutate(func(j *contracts.JudgeJob) { j.Problem.TestsetHash = "" }),
		"missing testset uri":   mutate(func(j *contracts.JudgeJob) { j.Problem.TestsetURI = "" }),
		"missing version id":    mutate(func(j *contracts.JudgeJob) { j.Problem.VersionID = "" }),
		"zero time limit":       mutate(func(j *contracts.JudgeJob) { j.Problem.Limits.TimeMS = 0 }),
		"zero memory limit":     mutate(func(j *contracts.JudgeJob) { j.Problem.Limits.MemMB = 0 }),
		"zero output limit":     mutate(func(j *contracts.JudgeJob) { j.Problem.Limits.OutputKB = 0 }),
		"float without eps":     mutate(func(j *contracts.JudgeJob) { j.Problem.Checker = contracts.Checker{Kind: contracts.CheckerKindFloat} }),
		"float with eps 0": mutate(func(j *contracts.JudgeJob) {
			j.Problem.Checker = contracts.Checker{Kind: contracts.CheckerKindFloat, Eps: &zero}
		}),
		"testlib no source": mutate(func(j *contracts.JudgeJob) { j.Problem.Checker = contracts.Checker{Kind: contracts.CheckerKindTestlib} }),
		"testlib empty source": mutate(func(j *contracts.JudgeJob) {
			j.Problem.Checker = contracts.Checker{Kind: contracts.CheckerKindTestlib, SourceURI: &empty}
		}),
		"unknown checker": mutate(func(j *contracts.JudgeJob) { j.Problem.Checker = contracts.Checker{Kind: "magic"} }),
	}
	for name, raw := range cases {
		t.Run("rejects "+name, func(t *testing.T) {
			if _, err := ParseJob(raw); !errors.Is(err, ErrInvalidJob) {
				t.Fatalf("got %v", err)
			}
		})
	}
	t.Run("accepts float with eps and testlib with a source", func(t *testing.T) {
		for _, c := range []contracts.Checker{{Kind: contracts.CheckerKindFloat, Eps: &eps}, {Kind: contracts.CheckerKindTestlib, SourceURI: &bin}, {Kind: contracts.CheckerKindExact}} {
			c := c
			if _, err := ParseJob(mutate(func(j *contracts.JudgeJob) { j.Problem.Checker = c })); err != nil {
				t.Fatalf("%+v: %v", c, err)
			}
		}
	})
}

func TestToResult(t *testing.T) {
	job := validJob("1")
	job.RunVersion = 4
	t.Run("FR-JUDGE-11: carries the submission id and run version", func(t *testing.T) {
		r := ToResult(job, &judge.Outcome{Verdict: contracts.VerdictAC, TimeMS: 12, MemKB: 340,
			Tests: []contracts.TestOutcome{{No: 1, Verdict: contracts.VerdictAC}}}, "w1", 99)
		if r.SubmissionID != "sub-1" || r.RunVersion != 4 || r.WorkerID != "w1" || r.FinishedAt != 99 || r.CompileLog != nil || len(r.Tests) != 1 {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("a CE result carries the compile log and an empty (not null) tests array", func(t *testing.T) {
		r := ToResult(job, &judge.Outcome{Verdict: contracts.VerdictCE, CompileLog: "main.c:1: error <x>"}, "w1", 1)
		if r.CompileLog == nil || *r.CompileLog != "main.c:1: error <x>" {
			t.Fatalf("%+v", r)
		}
		b, _ := marshal(r)
		if !strings.Contains(string(b), `"tests":[]`) || !strings.Contains(string(b), "<x>") {
			t.Fatalf("%s", b)
		}
	})
}

func TestPermanentErrors(t *testing.T) {
	for _, err := range []error{ErrInvalidJob, judge.ErrUnknownLanguage, testcache.ErrBadURI, testcache.ErrHashMismatch,
		testcache.ErrBadTestset, testcache.ErrNotFound, testcache.ErrBadHash, testcache.ErrTooLarge} {
		if !permanent(errors.Join(errors.New("wrapped"), err)) {
			t.Errorf("%v should be permanent", err)
		}
	}
	if permanent(errors.New("connection reset")) {
		t.Error("an unknown error must be retried")
	}
}
