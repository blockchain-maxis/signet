package link

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

// typed returns a Prompt that yields the given lines one per call, then blocks
// until the flow ends, like a terminal nobody is typing at.
func typed(lines ...string) func(context.Context) (string, error) {
	i := 0
	return func(ctx context.Context) (string, error) {
		if i < len(lines) {
			line := lines[i]
			i++
			return line, nil
		}
		<-ctx.Done()
		return "", ctx.Err()
	}
}

func TestRun_ManualCodeWinsWhenTheLoopbackCannotBind(t *testing.T) {
	// Polling never answers, so only the typed code can finish this.
	deps := baseDeps(pair.StatusPending)
	deps.TTL = 2 * time.Second
	deps.Listen = func(string) (Callbacks, error) { return nil, errors.New("permission denied") }
	deps.Prompt = typed("  abcd-2345 \n")
	// Report is called from the polling goroutine and the flow's own, so the
	// recorded lines need a lock for -race.
	var mu sync.Mutex
	var lines []string
	deps.Report = func(line string) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, line)
	}
	var sent string
	deps.Complete = func(_ context.Context, _, _, handoff string) (pair.Completed, error) {
		sent = handoff
		return pair.Completed{Handle: "alice"}, nil
	}

	result, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sent != "ABCD2345" {
		t.Fatalf("Complete received %q, want the typed code normalised to ABCD2345", sent)
	}
	if result.Handle != "alice" {
		t.Fatalf("result = %+v", result)
	}
	mu.Lock()
	offered := strings.Join(lines, "\n")
	mu.Unlock()
	if !strings.Contains(offered, "Paste the code shown in the browser") {
		t.Fatalf("never offered the prompt: %q", offered)
	}
}

func TestRun_BlankLinesDoNotCountAsACode(t *testing.T) {
	deps := baseDeps(pair.StatusPending)
	deps.TTL = 2 * time.Second
	deps.Listen = func(string) (Callbacks, error) { return nil, errors.New("no port") }
	deps.Prompt = typed("\n", "   \n", "WXYZ2345\n")
	var sent string
	deps.Complete = func(_ context.Context, _, _, handoff string) (pair.Completed, error) {
		sent = handoff
		return pair.Completed{}, nil
	}

	if _, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sent != "WXYZ2345" {
		t.Fatalf("Complete received %q", sent)
	}
}

func TestRun_PromptsOnlyAfterApprovalWhenNoCallbackArrives(t *testing.T) {
	// The loopback bound but nothing ever reaches it; polling says approved.
	cb := &fakeCallbacks{url: "http://127.0.0.1:1/callback", err: errors.New("never called back")}
	deps := baseDeps(pair.StatusApproved)
	deps.TTL = 2 * time.Second
	deps.ManualDelay = 20 * time.Millisecond
	deps.Listen = func(string) (Callbacks, error) { return cb, nil }
	deps.Prompt = typed("QWER5678\n")

	start := time.Now()
	var promptedAfter time.Duration
	deps.Report = func(line string) {
		if strings.Contains(line, "Paste the code") {
			promptedAfter = time.Since(start)
		}
	}
	var sent string
	deps.Complete = func(_ context.Context, _, _, handoff string) (pair.Completed, error) {
		sent = handoff
		return pair.Completed{}, nil
	}

	if _, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sent != "QWER5678" {
		t.Fatalf("Complete received %q", sent)
	}
	if promptedAfter < deps.ManualDelay {
		t.Fatalf("prompted after %s, before the %s the callback is given", promptedAfter, deps.ManualDelay)
	}
}

func TestRun_CallbackBeatsThePromptDuringTheGracePeriod(t *testing.T) {
	var callbackState string
	cb := &fakeCallbacks{url: "http://127.0.0.1:1/callback", delay: 40 * time.Millisecond}
	cb.stateFn = func() string { return callbackState }
	deps := baseDeps(pair.StatusApproved)
	deps.TTL = 2 * time.Second
	deps.ManualDelay = 2 * time.Second
	deps.Listen = func(string) (Callbacks, error) { return cb, nil }
	deps.Prompt = func(context.Context) (string, error) {
		t.Error("prompted although the callback was about to arrive")
		return "", errors.New("unexpected")
	}
	deps.Report = func(line string) {
		if s := stateFromURL(line); s != "" {
			callbackState = s
		}
	}

	if _, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestRun_NeverPromptsWithoutAPromptDep(t *testing.T) {
	// --json and a non-terminal stdin leave Prompt nil: an approved pairing
	// completes straight from polling, with no code.
	deps := baseDeps(pair.StatusApproved)
	deps.Listen = func(string) (Callbacks, error) { return nil, errors.New("no port") }
	deps.Complete = func(_ context.Context, _, _, handoff string) (pair.Completed, error) {
		if handoff != "" {
			t.Errorf("sent handoff code %q with nobody to type it", handoff)
		}
		return pair.Completed{}, nil
	}
	if _, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestRun_AWrongCodeSurfacesTheServersMessage(t *testing.T) {
	deps := baseDeps(pair.StatusPending)
	deps.TTL = 2 * time.Second
	deps.Listen = func(string) (Callbacks, error) { return nil, errors.New("no port") }
	deps.Prompt = typed("WRONG123\n")
	deps.Complete = func(context.Context, string, string, string) (pair.Completed, error) {
		return pair.Completed{}, fmt.Errorf("%w: That confirmation code does not match the one shown in the browser", exitcode.ErrNetwork)
	}

	_, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if err == nil || !strings.Contains(err.Error(), "does not match the one shown in the browser") {
		t.Fatalf("err = %v, want the server's bad-handoff message", err)
	}
	if code, _ := exitcode.CodeFor(err); code == exitcode.OK {
		t.Fatalf("exit code %d for a refused code", code)
	}
}

func TestRun_CtrlCSaysThePairingWasAbandonedAndWhenItExpires(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	deps := baseDeps(pair.StatusPending)
	deps.TTL = 5 * time.Second
	deps.Start = func(context.Context, string, string) (pair.Started, error) {
		return pair.Started{State: "p_1", PollToken: "tok", ExpiresAt: "2026-10-17T12:34:56Z"}, nil
	}
	deps.Report = func(line string) {
		if strings.Contains(line, "Waiting for approval") {
			cancel()
		}
	}

	_, err := Run(ctx, "https://signet.example", "testnet", "src", "GABC", deps)
	if !errors.Is(err, exitcode.ErrInterrupted) {
		t.Fatalf("err = %v, want ErrInterrupted", err)
	}
	if code, _ := exitcode.CodeFor(err); code != 130 {
		t.Fatalf("exit code = %d, want 130", code)
	}
	for _, want := range []string{"pairing abandoned", "the link expires at 2026-10-17T12:34:56Z"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %q, missing %q", err, want)
		}
	}
}

func TestRun_RelinkingReportsAlreadyLinked(t *testing.T) {
	deps := baseDeps(pair.StatusApproved)
	deps.Complete = func(context.Context, string, string, string) (pair.Completed, error) {
		return pair.Completed{Handle: "alice", Status: pair.StatusAlreadyLinked}, nil
	}
	result, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Status != "already-linked" {
		t.Fatalf("status = %q, want already-linked", result.Status)
	}
}

func TestRun_AServerThatSendsNoStatusIsAPlainLink(t *testing.T) {
	deps := baseDeps(pair.StatusApproved)
	result, err := Run(context.Background(), "https://signet.example", "testnet", "src", "GABC", deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Status != "linked" {
		t.Fatalf("status = %q, want linked", result.Status)
	}
}
