package cmd

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/networkcheck"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

// runSignet runs the root command with args and returns combined output.
func runSignet(t *testing.T, args ...string) (string, error) {
	t.Helper()
	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetIn(strings.NewReader(""))
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

// noStellarOnPath makes any attempt to resolve an identity fail, so a test
// passing with exit 3 proves the network check ran before identity
// resolution, not merely before the pairing request.
func noStellarOnPath(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
}

func assertMismatchBeforeAnyRequest(t *testing.T, out string, err error, srv *requestLog) {
	t.Helper()
	if err == nil {
		t.Fatalf("a mainnet run against a testnet deployment succeeded:\n%s", out)
	}
	if code := ExitCode(err); code != exitcode.Configuration {
		t.Fatalf("exit code = %d, want %d (%v)", code, exitcode.Configuration, err)
	}
	var mismatch *networkcheck.MismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("error is not a network mismatch: %v", err)
	}
	msg := err.Error()
	for _, want := range []string{"mainnet", "testnet", "--network testnet", "signet context use"} {
		if !strings.Contains(msg, want) {
			t.Errorf("mismatch message lacks %q: %s", want, msg)
		}
	}
	byPath, total := srv.snapshot()
	if byPath["/api/cli/pair/start"] != 0 {
		t.Fatalf("pair/start was requested %d time(s)", byPath["/api/cli/pair/start"])
	}
	if others := total - byPath["/.well-known/stellar.toml"]; others != 0 {
		t.Fatalf("made %d request(s) besides discovery: %v", others, byPath)
	}
	if byPath["/.well-known/stellar.toml"] != 1 {
		t.Fatalf("stellar.toml requested %d time(s), want 1", byPath["/.well-known/stellar.toml"])
	}
}

func TestLink_MainnetAgainstATestnetDeploymentExits3BeforeAnyRequest(t *testing.T) {
	isolateConfigDir(t)
	noStellarOnPath(t)
	srv, log := fakeDeployment(t, pair.Identity{})

	out, err := runSignet(t, "link", "--url", srv.URL, "--network", "mainnet", "--source", "alice", "--no-browser")
	assertMismatchBeforeAnyRequest(t, out, err, log)
}

func TestUnlink_MainnetAgainstATestnetDeploymentExits3BeforeAnyRequest(t *testing.T) {
	isolateConfigDir(t)
	noStellarOnPath(t)
	srv, log := fakeDeployment(t, pair.Identity{PublicKey: aliceKey, Handle: "alice", Linked: true})

	out, err := runSignet(t, "unlink", "--url", srv.URL, "--network", "mainnet", "--source", "alice", "--yes")
	assertMismatchBeforeAnyRequest(t, out, err, log)
}

func TestUnlink_ADeploymentWithoutStellarTOMLIsCheckedAtPairingInstead(t *testing.T) {
	// A deployment that predates the document is not refused: the server
	// still checks the network (#616). The run goes on, with a note.
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/cli/whoami" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"publicKey":"` + aliceKey + `","linked":false}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)

	out, err := runSignet(t, "unlink", "--url", srv.URL, "--network", "mainnet", "--source", "alice", "--yes")
	if err != nil {
		t.Fatalf("unlink failed against a deployment without stellar.toml: %v\n%s", err, out)
	}
	if !strings.Contains(out, "publishes no stellar.toml") {
		t.Fatalf("no note about the skipped check:\n%s", out)
	}
	if !strings.Contains(out, "is not linked") {
		t.Fatalf("unlink did not carry on to whoami:\n%s", out)
	}
}
