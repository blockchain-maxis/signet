package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

// The link command's behaviour lives in internal/link (see flow_test.go),
// which is where it can be driven against fakes. What is worth pinning here is
// the command's shape — the contract a script or a CI job depends on.

func TestLinkTakesNoArguments(t *testing.T) {
	// The handle comes from whoever is signed in when they approve in the
	// browser. Accepting one here would invite typing a handle you do not own.
	cmd := newLinkCmd()
	cmd.SetArgs([]string{"alice"})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("link accepted a positional handle")
	}
	if !strings.Contains(err.Error(), "unknown command") && !strings.Contains(err.Error(), "arg") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLinkFlags(t *testing.T) {
	cmd := newLinkCmd()
	if cmd.Flags().Lookup("no-browser") == nil {
		t.Fatal("--no-browser is missing")
	}
	// --network is the root's persistent flag now (#604), replacing link's local flag.
	root, _, _ := newTestRoot(t)
	sub, _, err := root.Find([]string{"link"})
	if err != nil || sub == nil {
		t.Fatalf("link command not found: %v", err)
	}
	if sub.InheritedFlags().Lookup("network") == nil {
		t.Fatal("link does not inherit --network from root")
	}
	if sub.LocalFlags().Lookup("network") != nil {
		t.Fatal("link declares its own --network; the root's persistent flag is the only definition")
	}

	// --json is the root's persistent flag now (#603), not a local one.
	assertInheritsJSON(t, "link")
	// --public-key is deliberately gone: the key is resolved from the local
	// stellar identity, never asserted on the command line, so that what gets
	// signed and what gets linked cannot disagree.
	if cmd.Flags().Lookup("public-key") != nil {
		t.Fatal("--public-key came back")
	}
}

func TestLinkOffersTheManualCodePromptOnlyToAPerson(t *testing.T) {
	prev := stdinIsTerminal
	t.Cleanup(func() { stdinIsTerminal = prev })

	stdinIsTerminal = func(io.Reader) bool { return true }
	if manualCodePrompt(false, strings.NewReader("")) == nil {
		t.Fatal("no prompt for a person at a terminal")
	}
	if manualCodePrompt(true, strings.NewReader("")) != nil {
		t.Fatal("--json must never prompt: stdout is promised to be one object")
	}

	stdinIsTerminal = func(io.Reader) bool { return false }
	if manualCodePrompt(false, strings.NewReader("")) != nil {
		t.Fatal("prompted although stdin is not a terminal")
	}
}

// neverIndexedClient is a pair.Client pointed at a deployment whose wallet
// never finishes indexing: every wallets listing reports indexingPending,
// and polls counts how many listings waitForIndexing has made.
func neverIndexedClient(t *testing.T, publicKey string, polls *atomic.Int32) *pair.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/profiles/alice/wallets" {
			polls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"address": publicKey, "isPrimary": true, "source": "cli", "indexingPending": true},
				},
				"meta": map[string]string{"source": "db"},
			})
			return
		}
		http.Error(w, "unexpected request "+r.URL.Path, http.StatusTeapot)
	}))
	t.Cleanup(srv.Close)
	client, err := pair.New(srv.URL, api.Options{UserAgent: "signet-test"})
	if err != nil {
		t.Fatalf("pair.New: %v", err)
	}
	return client
}

func TestWaitForIndexing_Cancelled(t *testing.T) {
	// A generous interval, so "within one interval" is a real bound and
	// not a race with the scheduler.
	prev := linkWaitInterval
	linkWaitInterval = 200 * time.Millisecond
	t.Cleanup(func() { linkWaitInterval = prev })

	var polls atomic.Int32
	client := neverIndexedClient(t, aliceKey, &polls)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *linkIndexing, 1)
	go func() {
		done <- waitForIndexing(ctx, client, "alice", aliceKey, 30*time.Minute, func(string) {})
	}()

	// Wait until the wait is polling, then interrupt it the way Ctrl-C
	// does: cancel the context it was given.
	deadline := time.Now().Add(5 * time.Second)
	for polls.Load() == 0 {
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("waitForIndexing never polled")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()

	select {
	case got := <-done:
		if got.Done || !got.Interrupted {
			t.Fatalf("result = %+v, want Done false, Interrupted true", got)
		}
	case <-time.After(linkWaitInterval):
		t.Fatalf("waitForIndexing did not return within one linkWaitInterval (%s) of cancellation", linkWaitInterval)
	}
}

func TestWaitForIndexing_Timeout(t *testing.T) {
	// Running out of time is not an interruption: same shape, but
	// Interrupted stays false so the caller can tell the two apart.
	fastWaitPolling(t)

	var polls atomic.Int32
	client := neverIndexedClient(t, aliceKey, &polls)
	got := waitForIndexing(context.Background(), client, "alice", aliceKey, 100*time.Millisecond, func(string) {})
	if got.Done || got.Interrupted {
		t.Fatalf("result = %+v, want Done false, Interrupted false", got)
	}
	if polls.Load() == 0 {
		t.Fatal("waitForIndexing never polled")
	}
}

func TestLinkWait_Interrupted(t *testing.T) {
	// The whole command, interrupted the way a person does it: Ctrl-C
	// while --wait is polling. The link already happened, so the exit
	// stays 0 and the result says the wait was interrupted, in JSON too.
	args, stdout, stderr, err := runInterruptedLink(t, true)
	if err != nil {
		t.Fatalf("link --wait --json interrupted: %v\nstdout:\n%s\nstderr:\n%s", err, stdout, stderr)
	}
	assertGolden(t, "link_wait_interrupted_json", renderRunOutput(args, stdout, stderr, nil))

	// Human mode prints the same outcome in words, not JSON.
	_, human, _, err := runInterruptedLink(t, false)
	if err != nil {
		t.Fatalf("link --wait interrupted: %v\n%s", err, human)
	}
	if !strings.Contains(human, "stopped waiting; check `signet status` later") {
		t.Fatalf("human output lacks the interrupted message:\n%s", human)
	}
}

// runInterruptedLink runs link --wait against a deployment that never
// indexes, cancels the command's context once the wait is polling, and
// returns the args it ran with plus the command's output. The link itself
// has already succeeded by then, so the command must exit 0.
func runInterruptedLink(t *testing.T, json bool) (args []string, stdout, stderr string, err error) {
	t.Helper()
	buildFakeStellarOnPath(t)
	withFakeSigning(t)
	fastLinkPolling(t)
	fastWaitPolling(t)
	isolateConfigDir(t)
	srv, polls := indexingDeployment(t, -1)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	root := newRootCmd("dev", "none")
	stdoutBuf, stderrBuf := &strings.Builder{}, &strings.Builder{}
	root.SetOut(stdoutBuf)
	root.SetErr(stderrBuf)
	root.SetIn(strings.NewReader(""))
	root.SetContext(ctx)
	args = []string{"link", "--url", srv.URL, "--source", "alice", "--no-browser", "--wait=30m"}
	if json {
		args = append(args, "--json")
	}
	root.SetArgs(args)

	done := make(chan error, 1)
	go func() { done <- root.Execute() }()

	// Wait until the wait phase is polling, then interrupt it.
	deadline := time.Now().Add(10 * time.Second)
	for polls.Load() == 0 {
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("link --wait never started polling")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()

	select {
	case err := <-done:
		return args, stdoutBuf.String(), stderrBuf.String(), err
	case <-time.After(10 * time.Second):
		t.Fatal("link --wait did not return after cancellation")
		return nil, "", "", nil
	}
}
