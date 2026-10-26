package cmd

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

// These tests pin every byte of what people read and scripts parse. A change
// to any of it fails here with a diff until the goldens are regenerated with
// `go test ./internal/cmd -update` — so the change shows up in review, where
// it can be judged deliberate or not. See cli/README.md.

// runGolden runs signet with args, against production Deps (the real API
// client, and `stellar` from PATH), and renders everything an invocation
// produces — stdout, stderr, and the error with its exit code — as one text
// block, so a golden file shows the whole contract of a run.
func runGolden(t *testing.T, args ...string) string {
	t.Helper()
	root := newRootCmdWithDeps(goldenVersion, "abc1234", defaultDeps())
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetIn(strings.NewReader(""))
	root.SetArgs(args)
	err := root.Execute()

	var out strings.Builder
	fmt.Fprintf(&out, "$ signet %s\n", strings.Join(args, " "))
	section := func(name, body string) {
		fmt.Fprintf(&out, "-- %s --\n", name)
		if body == "" {
			out.WriteString("(empty)\n")
			return
		}
		out.WriteString(body)
		if !strings.HasSuffix(body, "\n") {
			out.WriteString("\n")
		}
	}
	section("stdout", stdout.String())
	section("stderr", stderr.String())
	if err == nil {
		out.WriteString("-- exit 0 --\n")
	} else {
		section(fmt.Sprintf("exit %d", ExitCode(err)), err.Error())
	}
	return out.String()
}

// goldenServer is a testnet deployment that answers the whole link, unlink
// and whoami flows: the pairing reports pairStatus, and whoami reports
// identity.
func goldenServer(t *testing.T, pairStatus string, identity pair.Identity) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/stellar.toml":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte(testnetStellarTOML))
		case "/api/cli/pair/start":
			_, _ = w.Write([]byte(`{"state":"golden-state","pollToken":"golden-poll","userCode":"ABCD2345","expiresAt":"2026-01-01T00:05:00Z"}`))
		case "/api/cli/pair/status":
			_, _ = fmt.Fprintf(w, `{"status":%q}`, pairStatus)
		case "/api/cli-link":
			_, _ = w.Write([]byte(`{"transaction":"AAAAchallenge","network_passphrase":"Test SDF Network ; September 2015"}`))
		case "/api/cli/pair/complete":
			_, _ = fmt.Fprintf(w, `{"ok":true,"wallet":%q,"handle":"alice","indexingPending":false,"status":"linked"}`, aliceKey)
		case "/api/cli/unlink":
			_, _ = fmt.Fprintf(w, `{"ok":true,"wallet":%q,"handle":"alice"}`, aliceKey)
		case "/api/v1/lookup/" + identity.PublicKey:
			serveLookup(w, identity)
		default:
			http.Error(w, "unexpected request", http.StatusTeapot)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// withFakeSigning makes the fake stellar sign any challenge.
func withFakeSigning(t *testing.T) {
	t.Helper()
	t.Setenv("FAKESTELLAR_SIGN_STDOUT", "AAAAAgAAAABxdnhrZmFrZXNpZ25lZGVudmVsb3BlAAAAAAAAZA==")
}

// fastLinkPolling makes link poll without waiting real seconds.
func fastLinkPolling(t *testing.T) {
	t.Helper()
	prev := linkPollInterval
	linkPollInterval = time.Millisecond
	t.Cleanup(func() { linkPollInterval = prev })
}

// commandPaths lists the path to every visible command in the tree, root
// first, including cobra's help and completion commands.
func commandPaths(t *testing.T) [][]string {
	t.Helper()
	root, _, _ := newTestRoot(t)
	root.InitDefaultHelpCmd()
	root.InitDefaultCompletionCmd()

	var paths [][]string
	var walk func(c *cobra.Command, path []string)
	walk = func(c *cobra.Command, path []string) {
		paths = append(paths, path)
		for _, sub := range c.Commands() {
			if sub.Hidden {
				continue
			}
			walk(sub, append(append([]string(nil), path...), sub.Name()))
		}
	}
	walk(root, nil)
	return paths
}

func TestGolden_Help(t *testing.T) {
	for _, path := range commandPaths(t) {
		name := "help_root"
		if len(path) > 0 {
			name = "help_" + strings.Join(path, "_")
		}
		t.Run(name, func(t *testing.T) {
			isolateConfigDir(t)
			assertGolden(t, name, runGolden(t, append(path, "--help")...))
		})
	}
}

func TestGolden_Link(t *testing.T) {
	buildFakeStellarOnPath(t)
	withFakeSigning(t)
	fastLinkPolling(t)

	for _, tc := range []struct {
		name, status string
	}{
		{"success", "approved"},
		{"rejected", "rejected"},
		{"expired", "expired"},
	} {
		for _, mode := range []string{"human", "json"} {
			name := "link_" + tc.name + "_" + mode
			t.Run(name, func(t *testing.T) {
				isolateConfigDir(t)
				srv := goldenServer(t, tc.status, pair.Identity{})
				args := []string{"link", "--url", srv.URL, "--source", "alice", "--no-browser"}
				if mode == "json" {
					args = append(args, "--json")
				}
				assertGolden(t, name, runGolden(t, args...))
			})
		}
	}
}

func TestGolden_Unlink(t *testing.T) {
	buildFakeStellarOnPath(t)
	withFakeSigning(t)

	for _, tc := range []struct {
		name     string
		identity pair.Identity
	}{
		{"linked", pair.Identity{PublicKey: aliceKey, Handle: "alice", Linked: true, Network: "testnet"}},
		{"not_linked", pair.Identity{PublicKey: aliceKey, Network: "testnet"}},
	} {
		for _, mode := range []string{"human", "json"} {
			name := "unlink_" + tc.name + "_" + mode
			t.Run(name, func(t *testing.T) {
				isolateConfigDir(t)
				srv := goldenServer(t, "", tc.identity)
				args := []string{"unlink", "--url", srv.URL, "--source", "alice", "--yes"}
				if mode == "json" {
					args = append(args, "--json")
				}
				assertGolden(t, name, runGolden(t, args...))
			})
		}
	}
}

func TestGolden_Whoami(t *testing.T) {
	buildFakeStellarOnPath(t)

	for _, tc := range []struct {
		name     string
		identity pair.Identity
	}{
		{"linked", pair.Identity{PublicKey: aliceKey, Handle: "alice", Linked: true, Network: "testnet", Source: "onchain", IsPrimary: true}},
		{"linked_cli", pair.Identity{PublicKey: aliceKey, Handle: "alice", Linked: true, Network: "testnet", Source: "cli"}},
		{"not_linked", pair.Identity{PublicKey: aliceKey, Network: "testnet"}},
	} {
		for _, mode := range []string{"human", "json"} {
			name := "whoami_" + tc.name + "_" + mode
			t.Run(name, func(t *testing.T) {
				isolateConfigDir(t)
				srv := goldenServer(t, "", tc.identity)
				args := []string{"whoami", "--url", srv.URL, "--source", "alice"}
				if mode == "json" {
					args = append(args, "--json")
				}
				assertGolden(t, name, runGolden(t, args...))
			})
		}
	}
}

func TestGolden_Doctor(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T)
	}{
		{"all_green", buildFakeStellarOnPath},
		// The one failure: no stellar CLI on PATH at all.
		{"one_fail", noStellarOnPath},
	} {
		for _, mode := range []string{"human", "json"} {
			name := "doctor_" + tc.name + "_" + mode
			t.Run(name, func(t *testing.T) {
				isolateConfigDir(t)
				// The cache check creates its directory; keep it out of the
				// developer's real cache on every OS.
				cache := t.TempDir()
				t.Setenv("XDG_CACHE_HOME", cache)
				t.Setenv("LocalAppData", cache)
				tc.setup(t)
				t.Setenv("FAKESTELLAR_IDENTITIES", "alice")
				// A healthy testnet deployment, its address written as
				// <deployment> so the golden does not depend on the port.
				url := healthy.serve(t, time.Now())
				args := []string{"doctor", "--url", url, "--network", "testnet"}
				if mode == "json" {
					args = append(args, "--json")
				}
				out := runGolden(t, args...)
				out = strings.ReplaceAll(out, url, "<deployment>")
				out = strings.ReplaceAll(out, strings.TrimPrefix(url, "http://"), "<deployment>")
				assertGolden(t, name, out)
			})
		}
	}
}

func TestGolden_NetworkMismatch(t *testing.T) {
	isolateConfigDir(t)
	noStellarOnPath(t)
	srv := goldenServer(t, "", pair.Identity{})
	assertGolden(t, "network_mismatch",
		runGolden(t, "link", "--url", srv.URL, "--network", "mainnet", "--source", "alice", "--no-browser"))
}
