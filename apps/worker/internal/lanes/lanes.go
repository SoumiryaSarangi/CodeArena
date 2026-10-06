// Package lanes decides which lane a worker tries first for each claim
// (FR-QUEUE-02, ADR-005): strict priority contest > interactive > practice >
// rejudge, except that every 8th claim starts from the other end, so the
// lowest non-empty lane is never starved.
package lanes

import (
	"fmt"
	"sync/atomic"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

// Priority is the strict lane order, highest first.
var Priority = []contracts.Lane{
	contracts.LaneContest, contracts.LaneInteractive, contracts.LanePractice, contracts.LaneRejudge,
}

// FairnessEvery is the anti-starvation ratio: every 8th claim probes the lanes
// lowest-first. With every lane backlogged, 7 of 8 claims go to the top lane
// and 1 of 8 to the lowest non-empty lane. Larger values favour contests more
// but make the worst-case wait of a low lane longer (its jobs finish within
// FairnessEvery x queue-length claims); 8 keeps contest verdicts fast while
// bounding that wait.
const FairnessEvery = 8

// Picker hands out the probe order for each claim. It is safe for concurrent
// use: the 8-claim counter is per worker, not per goroutine.
type Picker struct {
	lanes []contracts.Lane // enabled lanes, in Priority order
	n     atomic.Uint64
	every uint64
}

// New builds a Picker for the lanes a worker serves (any subset, any order, no
// duplicates). every <= 0 means FairnessEvery.
func New(enabled []contracts.Lane, every int) (*Picker, error) {
	if len(enabled) == 0 {
		return nil, fmt.Errorf("lanes: at least one lane is required")
	}
	want := map[contracts.Lane]bool{}
	for _, l := range enabled {
		if !known(l) {
			return nil, fmt.Errorf("lanes: unknown lane %q", l)
		}
		if want[l] {
			return nil, fmt.Errorf("lanes: lane %q listed twice", l)
		}
		want[l] = true
	}
	p := &Picker{every: FairnessEvery}
	if every > 0 {
		p.every = uint64(every)
	}
	for _, l := range Priority {
		if want[l] {
			p.lanes = append(p.lanes, l)
		}
	}
	return p, nil
}

func known(l contracts.Lane) bool {
	for _, p := range Priority {
		if p == l {
			return true
		}
	}
	return false
}

// Lanes returns the enabled lanes, highest priority first.
func (p *Picker) Lanes() []contracts.Lane { return append([]contracts.Lane(nil), p.lanes...) }

// Next counts one claim and returns the order in which to probe the lanes:
// highest priority first, except every 8th claim, which goes lowest first so
// the first non-empty lane found is the lowest non-empty one.
func (p *Picker) Next() []contracts.Lane {
	out := p.Lanes()
	if p.n.Add(1)%p.every == 0 {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out
}
