package pair

import (
	"context"
	"errors"
	"testing"
	"time"
)

// fakeClock advances only when the code under test sleeps, so a five-minute
// TTL is exercised in microseconds and the test is deterministic.
type fakeClock struct {
	now    time.Time
	slept  []time.Duration
	cancel func()
}

func newClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time { return c.now }

func (c *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.slept = append(c.slept, d)
	c.now = c.now.Add(d)
	if c.cancel != nil {
		c.cancel()
	}
	return nil
}

func statuses(seq ...Status) func(context.Context) (Status, error) {
	i := 0
	return func(context.Context) (Status, error) {
		s := seq[min(i, len(seq)-1)]
		i++
		return s, nil
	}
}

func TestWait_ReturnsApproved(t *testing.T) {
	clock := newClock()
	outcome, err := WaitForApproval(context.Background(), WaitOptions{
		TTL:          5 * time.Minute,
		PollInterval: 2 * time.Second,
		GetStatus:    statuses(StatusPending, StatusPending, StatusApproved),
		Sleep:        clock.Sleep,
		Now:          clock.Now,
	})
	if err != nil {
		t.Fatalf("WaitForApproval: %v", err)
	}
	if outcome != OutcomeApproved {
		t.Fatalf("outcome = %q, want approved", outcome)
	}
	if len(clock.slept) != 3 {
		t.Fatalf("polled %d times, want 3", len(clock.slept))
	}
}

func TestWait_ReturnsRejectedWithoutWaitingOutTheTTL(t *testing.T) {
	clock := newClock()
	outcome, err := WaitForApproval(context.Background(), WaitOptions{
		TTL:          5 * time.Minute,
		PollInterval: 2 * time.Second,
		GetStatus:    statuses(StatusRejected),
		Sleep:        clock.Sleep,
		Now:          clock.Now,
	})
	if err != nil {
		t.Fatalf("WaitForApproval: %v", err)
	}
	if outcome != OutcomeRejected {
		t.Fatalf("outcome = %q, want rejected", outcome)
	}
	// The point of recording a refusal server-side: one poll, then exit.
	if len(clock.slept) != 1 {
		t.Fatalf("polled %d times after a rejection, want 1", len(clock.slept))
	}
}

func TestWait_TimesOutAtTheTTL(t *testing.T) {
	clock := newClock()
	outcome, err := WaitForApproval(context.Background(), WaitOptions{
		TTL:          10 * time.Second,
		PollInterval: 2 * time.Second,
		GetStatus:    statuses(StatusPending),
		Sleep:        clock.Sleep,
		Now:          clock.Now,
	})
	if err != nil {
		t.Fatalf("WaitForApproval: %v", err)
	}
	if outcome != OutcomeTimeout {
		t.Fatalf("outcome = %q, want timeout", outcome)
	}
	// Never polls past the deadline: 5 sleeps of 2s covers exactly the TTL.
	if len(clock.slept) != 5 {
		t.Fatalf("polled %d times, want 5", len(clock.slept))
	}
}

func TestWait_ReportsBeforeTheFirstPollAndCountsDown(t *testing.T) {
	clock := newClock()
	var seen []time.Duration
	_, err := WaitForApproval(context.Background(), WaitOptions{
		TTL:          10 * time.Second,
		PollInterval: 2 * time.Second,
		GetStatus:    statuses(StatusPending, StatusPending, StatusApproved),
		Sleep:        clock.Sleep,
		Now:          clock.Now,
		Report:       func(p Progress) { seen = append(seen, p.Remaining) },
	})
	if err != nil {
		t.Fatalf("WaitForApproval: %v", err)
	}
	// One report before waiting at all — the developer must never face a
	// blank terminal — then one per pending poll, strictly decreasing.
	if len(seen) != 3 {
		t.Fatalf("reported %d times, want 3 (one up front, two pending)", len(seen))
	}
	if seen[0] != 10*time.Second {
		t.Fatalf("first report = %v, want the full TTL", seen[0])
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] >= seen[i-1] {
			t.Fatalf("report %d (%v) did not count down from %v", i, seen[i], seen[i-1])
		}
	}
}

func TestWait_ExpiredFromTheServerEndsTheWait(t *testing.T) {
	clock := newClock()
	outcome, err := WaitForApproval(context.Background(), WaitOptions{
		TTL:          5 * time.Minute,
		PollInterval: 2 * time.Second,
		GetStatus:    statuses(StatusExpired),
		Sleep:        clock.Sleep,
		Now:          clock.Now,
	})
	if err != nil {
		t.Fatalf("WaitForApproval: %v", err)
	}
	if outcome != OutcomeExpired {
		t.Fatalf("outcome = %q, want expired", outcome)
	}
}

func TestWait_TransientPollErrorDoesNotEndTheWait(t *testing.T) {
	clock := newClock()
	calls := 0
	outcome, err := WaitForApproval(context.Background(), WaitOptions{
		TTL:          5 * time.Minute,
		PollInterval: 2 * time.Second,
		GetStatus: func(context.Context) (Status, error) {
			calls++
			if calls < 3 {
				return "", errors.New("connection reset")
			}
			return StatusApproved, nil
		},
		Sleep: clock.Sleep,
		Now:   clock.Now,
	})
	if err != nil {
		t.Fatalf("WaitForApproval: %v", err)
	}
	if outcome != OutcomeApproved {
		t.Fatalf("outcome = %q, want approved after transient failures", outcome)
	}
}

func TestWait_TimeoutReportsTheLastPollError(t *testing.T) {
	clock := newClock()
	boom := errors.New("connection reset")
	outcome, err := WaitForApproval(context.Background(), WaitOptions{
		TTL:          4 * time.Second,
		PollInterval: 2 * time.Second,
		GetStatus:    func(context.Context) (Status, error) { return "", boom },
		Sleep:        clock.Sleep,
		Now:          clock.Now,
	})
	if outcome != OutcomeTimeout {
		t.Fatalf("outcome = %q, want timeout", outcome)
	}
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the last poll error so the caller can say why", err)
	}
}

func TestWait_StopsWhenContextIsCancelled(t *testing.T) {
	clock := newClock()
	ctx, cancel := context.WithCancel(context.Background())
	clock.cancel = cancel

	_, err := WaitForApproval(ctx, WaitOptions{
		TTL:          5 * time.Minute,
		PollInterval: 2 * time.Second,
		GetStatus:    statuses(StatusPending),
		Sleep:        clock.Sleep,
		Now:          clock.Now,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}
