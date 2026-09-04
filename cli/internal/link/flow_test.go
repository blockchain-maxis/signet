package link

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/loopback"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

// fakeCallbacks stands in for the loopback server without binding a port.
type fakeCallbacks struct {
	url      string
	stateFn  func() string
	err      error
	delay    time.Duration
	gotState string
	closed   bool
}

func (f *fakeCallbacks) URL() string { return f.url }
func (f *fakeCallbacks) Close() error {
	f.closed = true
	return nil
}
func (f *fakeCallbacks) WaitFor(ctx context.Context, _ time.Duration, accept loopback.Accept) (url.Values, error) {
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	state := ""
	if f.stateFn != nil {
		state = f.stateFn()
	}
	values := url.Values{"state": {state}}
	if accept != nil && !accept(values) {
		// Mirrors the real server: a mismatch is rejected and the wait
		// continues, so from the caller's side nothing arrives.
		<-ctx.Done()
		return nil, ctx.Err()
	}
	f.gotState = state
	return values, nil
}

func baseDeps(status pair.Status) Deps {
	return Deps{
		Start: func(context.Context, string, string) (pair.Started, error) {
			return pair.Started{State: "p_1", PollToken: "tok"}, nil
		},
		Poll:      func(context.Context, string) (pair.Status, error) { return status, nil },
		Challenge: func(context.Context, string) (string, error) { return "UNSIGNED", nil },
		Sign:      func(string) (string, error) { return "SIGNED", nil },
		Complete:  func(context.Context, string, string, string) (string, error) { return "alice", nil },
		// Keep the suite fast: the real defaults are five minutes and two
		// seconds, and nothing here is testing wall-clock behaviour.
		TTL:          30 * time.Millisecond,
		PollInterval: 5 * time.Millisecond,
	}
}

func TestRun_LinksViaPollingWhenThereIsNoLoopback(t *testing.T) {
	deps := baseDeps(pair.StatusApproved)
	var signed string
	deps.Complete = func(_ context.Context, state, xdr, handoff string) (string, error) {
		signed = xdr
		if state != "p_1" {
			t.Errorf("completed the wrong pairing: %q", state)
		}
		if handoff != "" {
			t.Errorf("sent a handoff code on the automatic path: %q", handoff)
		}
		return "alice", nil
	}

	result, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Handle != "alice" || result.PublicKey != "GABC" || result.Status != "linked" {
		t.Fatalf("result = %+v", result)
	}
	if signed != "SIGNED" {
		t.Fatalf("completed with %q, not the signed challenge", signed)
	}
}

func TestRun_PutsTheCodeAndCallbackStateInTheApprovalURL(t *testing.T) {
	cb := &fakeCallbacks{url: "http://127.0.0.1:1234/callback", delay: time.Hour}
	deps := baseDeps(pair.StatusApproved)
	deps.Listen = func(string) (Callbacks, error) { return cb, nil }

	var printed string
	deps.Report = func(line string) {
		if strings.Contains(line, "/link?") {
			printed = line
		}
	}

	if _, err := Run(context.Background(), "https://signet.example/", "testnet", "src", "GABC", deps); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if !strings.Contains(printed, "https://signet.example/link?") {
		t.Fatalf("approval URL not printed: %q", printed)
	}
	parsed, err := url.Parse(strings.TrimSpace(printed[strings.Index(printed, "https://"):]))
	if err != nil {
		t.Fatalf("parsing printed URL: %v", err)
	}
	q := parsed.Query()
	if q.Get("code") != "p_1" {
		t.Fatalf("code = %q", q.Get("code"))
	}
	if q.Get("callback") != cb.url {
		t.Fatalf("callback = %q", q.Get("callback"))
	}
	if len(q.Get("callback_state")) < 32 {
		t.Fatalf("callback_state is missing or too short: %q", q.Get("callback_state"))
	}
	if !cb.closed {
		t.Fatal("loopback server was not closed")
	}
}

// stateFromURL pulls callback_state out of the approval URL the flow prints,
// which is the only place a test can learn the value Run generated.
func stateFromURL(line string) string {
	i := strings.Index(line, "https://")
	if i < 0 {
		return ""
	}
	parsed, err := url.Parse(strings.TrimSpace(line[i:]))
	if err != nil {
		return ""
	}
	return parsed.Query().Get("callback_state")
}

func TestRun_LoopbackCallbackWinsWhenItArrivesFirst(t *testing.T) {
	var callbackState string
	cb := &fakeCallbacks{url: "http://127.0.0.1:1/callback"}
	cb.stateFn = func() string { return callbackState }

	// Polling would sit pending forever, so only the callback can finish this.
	deps := baseDeps(pair.StatusPending)
	deps.Listen = func(string) (Callbacks, error) { return cb, nil }
	deps.Report = func(line string) {
		if s := stateFromURL(line); s != "" {
			callbackState = s
		}
	}

	result, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Status != "linked" {
		t.Fatalf("result = %+v", result)
	}
	if cb.gotState != callbackState || callbackState == "" {
		t.Fatalf("callback was accepted with state %q, want %q", cb.gotState, callbackState)
	}
}

func TestRun_CallbackWithTheWrongStateDoesNotFinishTheLink(t *testing.T) {
	// A hostile page hitting the port supplies its own state. MatchState
	// rejects it, so the flow must fall through to polling rather than
	// treating it as an approval (#256).
	cb := &fakeCallbacks{url: "http://127.0.0.1:1/callback"}
	cb.stateFn = func() string { return "attacker-chosen" }

	deps := baseDeps(pair.StatusExpired)
	deps.Listen = func(string) (Callbacks, error) { return cb, nil }
	deps.Complete = func(context.Context, string, string, string) (string, error) {
		t.Fatal("completed on a callback with a mismatched state")
		return "", nil
	}

	_, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if !errors.Is(err, exitcode.ErrTimeout) {
		t.Fatalf("err = %v, want the wait to end without the callback counting", err)
	}
}

func TestRun_RejectedApprovalExitsWithoutSigning(t *testing.T) {
	deps := baseDeps(pair.StatusRejected)
	deps.Sign = func(string) (string, error) {
		t.Fatal("signed after the approval was refused")
		return "", nil
	}
	deps.Complete = func(context.Context, string, string, string) (string, error) {
		t.Fatal("completed after the approval was refused")
		return "", nil
	}

	_, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if !errors.Is(err, exitcode.ErrApprovalRejected) {
		t.Fatalf("err = %v, want ErrApprovalRejected", err)
	}
	if !strings.Contains(err.Error(), "nothing was linked") {
		t.Fatalf("err is not reassuring about state: %v", err)
	}
}

func TestRun_TimeoutTellsYouHowToRetry(t *testing.T) {
	deps := baseDeps(pair.StatusExpired)

	_, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if !errors.Is(err, exitcode.ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	// #265: on timeout, print how to retry including the manual URL.
	if !strings.Contains(err.Error(), "signet link") || !strings.Contains(err.Error(), "/link?code=p_1") {
		t.Fatalf("timeout message is not actionable: %v", err)
	}
}

func TestRun_AlreadyLinkedIsItsOwnFailureMode(t *testing.T) {
	deps := baseDeps(pair.StatusApproved)
	deps.Complete = func(context.Context, string, string, string) (string, error) {
		return "", errors.New("network error: This deploy account is already bound to a different profile")
	}

	_, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if !errors.Is(err, exitcode.ErrAlreadyLinked) {
		t.Fatalf("err = %v, want ErrAlreadyLinked", err)
	}
}

func TestRun_FallsBackToPollingWhenTheLoopbackCannotBind(t *testing.T) {
	deps := baseDeps(pair.StatusApproved)
	deps.Listen = func(string) (Callbacks, error) { return nil, errors.New("permission denied") }

	var lines []string
	deps.Report = func(line string) { lines = append(lines, line) }

	result, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Status != "linked" {
		t.Fatalf("result = %+v", result)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "falling back to polling") {
		t.Fatalf("did not explain the fallback: %q", joined)
	}
	if strings.Contains(joined, "callback=") {
		t.Fatal("advertised a callback URL that was never bound")
	}
}

func TestRun_SigningFailureStopsBeforeComplete(t *testing.T) {
	deps := baseDeps(pair.StatusApproved)
	deps.Sign = func(string) (string, error) {
		return "", errors.New("signing failed: identity not found")
	}
	deps.Complete = func(context.Context, string, string, string) (string, error) {
		t.Fatal("completed without a signature")
		return "", nil
	}

	if _, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps); err == nil {
		t.Fatal("expected a signing error")
	}
}
