// Package worker is the judge's Redis loop (SD-§5.2, §7): it consumes judge
// jobs from a lane stream, runs them through the judge engine and publishes
// progress and results.
package worker

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/judge"
)

// Stream entry fields. A jobs entry carries the JudgeJob as JSON in the field
// "job"; a results entry carries the JudgeResult as JSON in "result". Redis
// stream entries are flat string maps, so one JSON field keeps the contract
// (Zod -> JSON Schema -> Go types) as the single source of truth.
const (
	FieldJob    = "job"
	FieldResult = "result"
)

const (
	maxSourceBytes = 64 * 1024
	maxInputBytes  = 1024 * 1024
)

var (
	traceparentRe = regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`)
	// ErrInvalidJob is wrapped by every job validation error.
	ErrInvalidJob = errors.New("worker: invalid job")
)

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidJob, fmt.Sprintf(format, args...))
}

// ParseJob decodes and validates a JudgeJob the way the Zod schema does
// (packages/contracts/src/judge.ts): unknown fields, missing required fields
// and out-of-range values are rejected. The worker never trusts the stream.
func ParseJob(raw string) (contracts.JudgeJob, error) {
	var j contracts.JudgeJob
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&j); err != nil {
		return j, invalid("%v", err)
	}
	if dec.More() {
		return j, invalid("trailing data after the job")
	}
	switch {
	case j.JobID == "" || j.SubmissionID == "":
		return j, invalid("jobId and submissionId are required")
	case j.RunVersion < 1 || j.Seq < 0:
		return j, invalid("runVersion must be >= 1 and seq >= 0")
	case !validLane(j.Lane):
		return j, invalid("unknown lane %q", j.Lane)
	case j.Mode != contracts.JobModeRun && j.Mode != contracts.JobModeSubmit:
		return j, invalid("unknown mode %q", j.Mode)
	case len(j.Source) > maxSourceBytes:
		return j, invalid("source exceeds 64 KB")
	case j.CustomInput != nil && len(*j.CustomInput) > maxInputBytes:
		return j, invalid("input exceeds 1 MB")
	case !traceparentRe.MatchString(j.Traceparent):
		return j, invalid("bad traceparent")
	case j.Problem.VersionID == "" || j.Problem.TestsetHash == "" || j.Problem.TestsetURI == "":
		return j, invalid("problem versionId, testsetHash and testsetUri are required")
	case j.Problem.Limits.TimeMS < 1 || j.Problem.Limits.MemMB < 1 || j.Problem.Limits.OutputKB < 1:
		return j, invalid("limits must be positive")
	}
	switch c := j.Problem.Checker; c.Kind {
	case contracts.CheckerKindExact, contracts.CheckerKindTokens:
	case contracts.CheckerKindFloat:
		if c.Eps == nil || *c.Eps <= 0 {
			return j, invalid("float checker requires a positive eps")
		}
	case contracts.CheckerKindTestlib:
		if c.SourceURI == nil || *c.SourceURI == "" {
			return j, invalid("testlib checker requires sourceUri")
		}
	default:
		return j, invalid("unknown checker kind %q", c.Kind)
	}
	return j, nil
}

func validLane(l contracts.Lane) bool {
	switch l {
	case contracts.LaneContest, contracts.LaneInteractive, contracts.LanePractice, contracts.LaneRejudge:
		return true
	}
	return false
}

// ToResult builds the JudgeResult published on the results stream.
func ToResult(job contracts.JudgeJob, o *judge.Outcome, workerID string, nowMS int64) contracts.JudgeResult {
	res := contracts.JudgeResult{
		SubmissionID: job.SubmissionID,
		RunVersion:   job.RunVersion,
		Verdict:      o.Verdict,
		TimeMS:       o.TimeMS,
		MemKB:        o.MemKB,
		Tests:        o.Tests,
		WorkerID:     workerID,
		FinishedAt:   nowMS,
	}
	if res.Tests == nil {
		res.Tests = []contracts.TestOutcome{} // the schema wants an array, never null
	}
	if o.Verdict == contracts.VerdictCE {
		log := o.CompileLog
		res.CompileLog = &log
	}
	res.Output, res.Stderr = o.Output, o.Stderr // custom runs only
	return res
}

// marshal encodes without HTML escaping, so source-derived text stays readable.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
