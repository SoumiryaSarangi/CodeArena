package lanes

import (
	"fmt"
	"sync"
	"testing"

	"github.com/SoumiryaSarangi/CodeArena/apps/worker/internal/contracts"
)

const (
	C = contracts.LaneContest
	I = contracts.LaneInteractive
	P = contracts.LanePractice
	R = contracts.LaneRejudge
)

func mustNew(t *testing.T, ls ...contracts.Lane) *Picker {
	t.Helper()
	p, err := New(ls, 0)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func eq(a, b []contracts.Lane) bool { return fmt.Sprint(a) == fmt.Sprint(b) }

// claim simulates one claim: probe in the picker's order, take the first
// non-empty lane. queues holds the jobs left per lane.
func claim(p *Picker, queues map[contracts.Lane]int) (contracts.Lane, bool) {
	for _, l := range p.Next() {
		if queues[l] > 0 {
			queues[l]--
			return l, true
		}
	}
	return "", false
}

func TestOrdering(t *testing.T) {
	t.Run("FR-QUEUE-02: lanes are probed contest > interactive > practice > rejudge", func(t *testing.T) {
		p := mustNew(t, R, P, I, C) // listed in any order
		for i := 1; i <= 7; i++ {
			if got := p.Next(); !eq(got, []contracts.Lane{C, I, P, R}) {
				t.Fatalf("claim %d: %v", i, got)
			}
		}
	})
	t.Run("FR-QUEUE-02: every 8th claim starts from the lowest lane", func(t *testing.T) {
		p := mustNew(t, C, I, P, R)
		for round := 0; round < 3; round++ {
			for i := 1; i <= 7; i++ {
				if got := p.Next(); got[0] != C {
					t.Fatalf("round %d claim %d started at %s", round, i, got[0])
				}
			}
			if got := p.Next(); !eq(got, []contracts.Lane{R, P, I, C}) {
				t.Fatalf("round %d claim 8: %v", round, got)
			}
		}
	})
	t.Run("a worker serving a subset keeps the relative order", func(t *testing.T) {
		p := mustNew(t, P, C)
		if got := p.Next(); !eq(got, []contracts.Lane{C, P}) {
			t.Fatalf("%v", got)
		}
		single := mustNew(t, R)
		if got := single.Next(); !eq(got, []contracts.Lane{R}) {
			t.Fatalf("%v", got)
		}
	})
	t.Run("a custom ratio is honoured", func(t *testing.T) {
		p, _ := New([]contracts.Lane{C, R}, 3)
		got := []contracts.Lane{p.Next()[0], p.Next()[0], p.Next()[0]}
		if !eq(got, []contracts.Lane{C, C, R}) {
			t.Fatalf("%v", got)
		}
	})
}

func TestStarvationBound(t *testing.T) {
	t.Run("FR-QUEUE-02: with every lane backlogged, 7 of 8 claims go to contest and 1 of 8 to rejudge", func(t *testing.T) {
		p := mustNew(t, C, I, P, R)
		q := map[contracts.Lane]int{C: 1 << 30, I: 1 << 30, P: 1 << 30, R: 1 << 30}
		count := map[contracts.Lane]int{}
		for i := 0; i < 8000; i++ {
			l, _ := claim(p, q)
			count[l]++
		}
		if count[C] != 7000 || count[R] != 1000 || count[I] != 0 || count[P] != 0 {
			t.Fatalf("%v", count)
		}
	})
	t.Run("FR-QUEUE-02: a rejudge job waits at most 8 claims per job ahead of it, however deep the contest queue", func(t *testing.T) {
		p := mustNew(t, C, I, P, R)
		q := map[contracts.Lane]int{C: 1 << 30, R: 25}
		done := 0
		for claims := 1; done < 25; claims++ {
			if l, _ := claim(p, q); l == R {
				done++
				if claims != 8*done {
					t.Fatalf("rejudge job %d finished at claim %d, want %d", done, claims, 8*done)
				}
			}
			if claims > 8*25 {
				t.Fatal("rejudge starved")
			}
		}
	})
	t.Run("the lowest NON-EMPTY lane gets the fairness slot, not rejudge specifically", func(t *testing.T) {
		p := mustNew(t, C, I, P, R)
		q := map[contracts.Lane]int{C: 1 << 30, P: 10} // rejudge and interactive empty
		practice := 0
		for i := 0; i < 80; i++ {
			if l, _ := claim(p, q); l == P {
				practice++
			}
		}
		if practice != 10 {
			t.Fatalf("practice served %d of 10 within 80 claims", practice)
		}
	})
	t.Run("documented limit: a MIDDLE lane is only served when it is the lowest non-empty one", func(t *testing.T) {
		// contest and practice both permanently backlogged: the fairness slot goes to
		// practice (lowest non-empty), so interactive gets nothing. ADR-005 records this.
		p := mustNew(t, C, I, P, R)
		q := map[contracts.Lane]int{C: 1 << 30, I: 100, P: 1 << 30}
		interactive := 0
		for i := 0; i < 800; i++ {
			if l, _ := claim(p, q); l == I {
				interactive++
			}
		}
		if interactive != 0 {
			t.Fatalf("interactive served %d times; the rule only protects the lowest non-empty lane", interactive)
		}
	})
	t.Run("priority holds when nothing is backlogged: a late contest job jumps ahead of waiting practice jobs", func(t *testing.T) {
		p := mustNew(t, C, I, P, R)
		q := map[contracts.Lane]int{P: 5}
		claim(p, q)
		q[C] = 1
		if l, _ := claim(p, q); l != C {
			t.Fatalf("picked %s while a contest job waited", l)
		}
	})
	t.Run("an empty system claims nothing", func(t *testing.T) {
		if l, ok := claim(mustNew(t, C, I, P, R), map[contracts.Lane]int{}); ok {
			t.Fatalf("claimed %s from nothing", l)
		}
	})
}

func TestNewRejects(t *testing.T) {
	for name, ls := range map[string][]contracts.Lane{
		"none": nil, "unknown": {C, "vip"}, "duplicate": {C, C},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := New(ls, 0); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestConcurrentCounter(t *testing.T) {
	t.Run("the 8-claim counter is shared across goroutines: exactly 1 in 8 claims starts lowest-first", func(t *testing.T) {
		p := mustNew(t, C, R)
		var mu sync.Mutex
		low := 0
		var wg sync.WaitGroup
		for g := 0; g < 8; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 1000; i++ {
					if p.Next()[0] == R {
						mu.Lock()
						low++
						mu.Unlock()
					}
				}
			}()
		}
		wg.Wait()
		if low != 1000 {
			t.Fatalf("%d lowest-first claims out of 8000, want 1000", low)
		}
	})
}
