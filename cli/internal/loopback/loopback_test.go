package loopback

import (
	"context"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestNew_BindsLoopbackOnly(t *testing.T) {
	s, err := New("/callback")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Close()

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
	defer s.Close()

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
		_, _ = http.Get(s.URL() + "?code=abc123&state=xyz")
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
		_, _ = http.Get(url + "?code=first")
	}()

	if _, err := s.Wait(context.Background(), 5*time.Second); err != nil {
		t.Fatalf("Wait: %v", err)
	}

	// The listener is torn down as part of Wait's shutdown — a second request
	// must not be served.
	client := &http.Client{Timeout: 500 * time.Millisecond}
	_, err = client.Get(url + "?code=second")
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
