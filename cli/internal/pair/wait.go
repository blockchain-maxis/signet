package pair

import (
	"context"
	"time"
)

// Outcome is how a wait ended. approved/rejected/expired are answers from the
// server; Timeout means the CLI reached the pairing's TTL without one, which
// is the case #265 is actually about — the developer walked away, or the
// browser never opened.
type Outcome string

const (
	OutcomeApproved Outcome = "approved"
	OutcomeRejected Outcome = "rejected"
	OutcomeExpired  Outcome = "expired"
	OutcomeTimeout  Outcome = "timeout"
)

// Progress is handed to WaitOptions.Report so the caller can keep the terminal
// alive. Remaining counts down to the pairing's expiry.
type Progress struct {
	Remaining time.Duration
}

// WaitOptions configures WaitForApproval. GetStatus, Sleep and Now are
// injectable so the loop is testable against a fake clock with no real waiting
// and no network — a test for a five-minute timeout that actually takes five
// minutes is a test nobody runs.
type WaitOptions struct {
	// TTL bounds the wait. It is the pairing's own lifetime, so the CLI never
	// polls past the point where the code could still be used — the issue's
	// "the pairing code's own TTL and the CLI timeout are consistent".
	TTL time.Duration
	// PollInterval is how long to sleep between polls.
	PollInterval time.Duration
	// GetStatus asks the server for the current state. Anything other than
	// pending ends the wait.
	GetStatus func(context.Context) (Status, error)
	// Sleep waits between polls. Defaults to a context-aware time.Sleep.
	Sleep func(context.Context, time.Duration) error
	// Now reads the clock. Defaults to time.Now.
	Now func() time.Time
	// Report is called once before the first poll and after every poll that
	// comes back pending, so the caller can render a countdown instead of a
	// blank terminal.
	Report func(Progress)
}

// WaitForApproval polls until the pairing is answered, the pairing expires, or
// ctx is cancelled.
//
// It reports what it is waiting for *before* it starts waiting, and again on
// every pending poll, because the failure this fixes is not a hang — it is a
// hang the developer cannot distinguish from a crash.
//
// A transient polling error does not end the wait: a laptop that slept, a
// dropped wifi connection, or a deployment restarting mid-approval are all
// recoverable, and the pairing is still valid until its TTL. The last error is
// returned only if the wait then runs out of time, so the caller can say why.
func WaitForApproval(ctx context.Context, opts WaitOptions) (Outcome, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	sleep := opts.Sleep
	if sleep == nil {
		sleep = contextSleep
	}
	report := opts.Report
	if report == nil {
		report = func(Progress) {}
	}

	deadline := now().Add(opts.TTL)
	report(Progress{Remaining: opts.TTL})

	var lastErr error
	for {
		// Sleeping first lets the "waiting for approval" line land before the
		// first poll, so the terminal is never blank while a request is out.
		if err := sleep(ctx, opts.PollInterval); err != nil {
			return OutcomeTimeout, err
		}

		status, err := opts.GetStatus(ctx)
		if err != nil {
			// Cancellation is the caller giving up, not a transient failure.
			if ctx.Err() != nil {
				return OutcomeTimeout, ctx.Err()
			}
			lastErr = err
		} else {
			switch status {
			case StatusApproved, StatusCompleted:
				return OutcomeApproved, nil
			case StatusRejected:
				return OutcomeRejected, nil
			case StatusExpired:
				return OutcomeExpired, nil
			}
			lastErr = nil
		}

		remaining := deadline.Sub(now())
		if remaining <= 0 {
			return OutcomeTimeout, lastErr
		}
		report(Progress{Remaining: remaining})
	}
}

// contextSleep waits for d, or returns early if ctx is cancelled first.
func contextSleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
