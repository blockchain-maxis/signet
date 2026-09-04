package loopback

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// getAndDiscard issues a GET and closes the response body. These tests only
// care that the request reached the server and how it answered at the
// transport level, never about the body itself — but an unclosed body leaks a
// connection, so it is closed rather than ignored.
func getAndDiscard(client *http.Client, url string) error {
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

func TestNew_BindsLoopbackOnly(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = s.Close() }()

	host, _, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort: %v", err)
	}
	if host != "127.0.0.1" {
		t.Fatalf("bound to %q, want 127.0.0.1 only", host)
	}
}

func TestNew_PortIsAvailableBeforeWait(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = s.Close() }()

	if s.Port() == 0 {
		t.Fatal("Port() is 0 before Wait was called")
	}
	if !strings.Contains(s.URL(), "/callback") {
		t.Fatalf("URL() = %q, want it to contain /callback", s.URL())
	}
}

func TestWait_ReturnsCallbackQueryParams(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	go func() {
		time.Sleep(20 * time.Millisecond)
		_ = getAndDiscard(http.DefaultClient, s.URL()+"?code=abc123&state=xyz")
	}()

	values, err := s.Wait(context.Background(), 5*time.Second)
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if values.Get("code") != "abc123" || values.Get("state") != "xyz" {
		t.Fatalf("got %v", values)
	}
}

func TestWait_ServesExactlyOnce(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	url := s.URL()

	go func() {
		time.Sleep(20 * time.Millisecond)
		_ = getAndDiscard(http.DefaultClient, url+"?code=first")
	}()

	if _, err := s.Wait(context.Background(), 5*time.Second); err != nil {
		t.Fatalf("Wait: %v", err)
	}

	// The listener is torn down as part of Wait's shutdown — a second request
	// must not be served.
	client := &http.Client{Timeout: 500 * time.Millisecond}
	err = getAndDiscard(client, url+"?code=second")
	if err == nil {
		t.Fatal("a second request was served after the server should have shut down")
	}
}

func TestWait_RespectsContextCancellation(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	_, err = s.Wait(ctx, time.Minute)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected an error from a cancelled context")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("Wait took %v after cancellation — SIGINT should shut it down promptly", elapsed)
	}
}

func TestWait_RespectsTimeout(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	start := time.Now()
	_, err = s.Wait(context.Background(), 100*time.Millisecond)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected a timeout error when no callback ever arrives")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("Wait took %v, want it bounded near the 100ms timeout", elapsed)
	}
}

func TestWait_SecondCallIsAnError(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	_, _ = s.Wait(context.Background(), 50*time.Millisecond)

	if _, err := s.Wait(context.Background(), 50*time.Millisecond); err != ErrAlreadyWaiting {
		t.Fatalf("got %v, want ErrAlreadyWaiting", err)
	}
}

// ── state verification (RFC 8252 loopback-redirect hardening) ────────────

func TestNewState_IsRandomAndUrlSafe(t *testing.T) {
	a, err := NewState()
	if err != nil {
		t.Fatalf("NewState: %v", err)
	}
	b, err := NewState()
	if err != nil {
		t.Fatalf("NewState: %v", err)
	}
	if a == b {
		t.Fatal("NewState returned the same value twice")
	}
	if len(a) < 32 {
		t.Fatalf("state %q is too short to be unguessable", a)
	}
	if strings.ContainsAny(a, "+/=&?#") {
		t.Fatalf("state %q is not safe to put in a URL unescaped", a)
	}
}

func TestMatchState(t *testing.T) {
	accept := MatchState("expected")
	if !accept(url.Values{"state": {"expected"}}) {
		t.Fatal("rejected the matching state")
	}
	for _, wrong := range []url.Values{
		{"state": {"other"}},
		{"state": {"expected "}},
		{"state": {"EXPECTED"}},
		{"state": {""}},
		{},
	} {
		if accept(wrong) {
			t.Fatalf("accepted %v", wrong)
		}
	}
}

func TestWaitFor_RejectsMismatchedStateWithoutEndingTheWait(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	target := s.URL()

	go func() {
		// A hostile page hits the port first with its own state. The wait
		// must survive this — the whole attack is aborting or hijacking the
		// developer's link.
		time.Sleep(20 * time.Millisecond)
		_ = getAndDiscard(http.DefaultClient, target+"?state=attacker&code=evil")
		time.Sleep(20 * time.Millisecond)
		_ = getAndDiscard(http.DefaultClient, target+"?state=expected&code=real")
	}()

	values, err := s.WaitFor(context.Background(), 5*time.Second, MatchState("expected"))
	if err != nil {
		t.Fatalf("WaitFor: %v", err)
	}
	if values.Get("code") != "real" {
		t.Fatalf("returned the attacker's callback: %v", values)
	}
}

func TestWaitFor_MismatchedStateGetsA400(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	target := s.URL()

	codes := make(chan int, 1)
	go func() {
		time.Sleep(20 * time.Millisecond)
		resp, err := http.Get(target + "?state=wrong")
		if err == nil {
			codes <- resp.StatusCode
			_ = resp.Body.Close()
		} else {
			codes <- 0
		}
		time.Sleep(20 * time.Millisecond)
		_ = getAndDiscard(http.DefaultClient, target+"?state=right")
	}()

	if _, err := s.WaitFor(context.Background(), 5*time.Second, MatchState("right")); err != nil {
		t.Fatalf("WaitFor: %v", err)
	}
	if got := <-codes; got != http.StatusBadRequest {
		t.Fatalf("mismatched callback got %d, want 400", got)
	}
}

func TestWaitFor_StillTimesOutIfOnlyMismatchesArrive(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	target := s.URL()

	go func() {
		for i := 0; i < 3; i++ {
			time.Sleep(10 * time.Millisecond)
			_ = getAndDiscard(http.DefaultClient, target+"?state=wrong")
		}
	}()

	_, err = s.WaitFor(context.Background(), 150*time.Millisecond, MatchState("right"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want a deadline error", err)
	}
}
