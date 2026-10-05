package contracts

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func roundTrip[T any](t *testing.T, file string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contracts", "fixtures", file))
	if err != nil {
		t.Fatal(err)
	}
	var v T
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("%s: decode: %v", file, err)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("%s: round trip changed the message\nwant %v\ngot  %v", file, want, got)
	}
}

func TestF03_FixturesRoundTrip(t *testing.T) {
	t.Run("JudgeJob", func(t *testing.T) { roundTrip[JudgeJob](t, "judge-job.json") })
	t.Run("JudgeProgress", func(t *testing.T) { roundTrip[JudgeProgress](t, "judge-progress.json") })
	t.Run("JudgeResult", func(t *testing.T) { roundTrip[JudgeResult](t, "judge-result.json") })
}

func TestFRJUDGE05_VerdictNames(t *testing.T) {
	for _, v := range []Verdict{VerdictAC, VerdictWA, VerdictTLE, VerdictMLE, VerdictOLE, VerdictRE, VerdictCE, VerdictSE} {
		if v == "" {
			t.Fatal("empty verdict constant")
		}
	}
}
