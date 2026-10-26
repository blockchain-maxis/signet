package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

func TestWhoamiTakesNoArguments(t *testing.T) {
	cmd := newWhoamiCmd()
	cmd.SetArgs([]string{"extra"})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})

	if err := cmd.Execute(); err == nil {
		t.Fatal("whoami accepted a positional argument")
	}
}

func TestWhoamiHasJSONOutput(t *testing.T) {
	assertInheritsJSON(t, "whoami")
}

func TestWhoamiHelpNeverSuggestsASecret(t *testing.T) {
	// #260 is explicit that this must never print a secret key. The command
	// has no way to read one — the public key comes from `stellar keys
	// address` — so what is worth pinning is that its own text never invites
	// one either.
	cmd := newWhoamiCmd()
	text := cmd.Long + " " + cmd.Short
	for _, forbidden := range []string{"secret key S", "--secret", "seed phrase"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("help text mentions %q", forbidden)
		}
	}
	if !strings.Contains(cmd.Long, "Never prints a secret key") {
		t.Fatal("help text does not state the guarantee")
	}
}

// whoami reports how the wallet was linked and whether it is primary (#645),
// from GET /api/v1/lookup/{address}.
func TestWhoamiReportsTheWalletSourceAndPrimary(t *testing.T) {
	buildFakeStellarOnPath(t)
	for _, tc := range []struct {
		identity pair.Identity
		human    string
	}{
		{pair.Identity{PublicKey: aliceKey, Handle: "alice", Linked: true, Source: "cli"}, "source:     cli\nprimary:    no"},
		{pair.Identity{PublicKey: aliceKey, Handle: "alice", Linked: true, Source: "onchain", IsPrimary: true}, "source:     onchain\nprimary:    yes"},
	} {
		isolateConfigDir(t)
		srv, log := fakeDeployment(t, tc.identity)
		out, err := runSignet(t, "whoami", "--url", srv.URL, "--source", "alice", "--json")
		if err != nil {
			t.Fatalf("whoami --json: %v\n%s", err, out)
		}
		var got whoamiResult
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			t.Fatalf("decoding %q: %v", out, err)
		}
		if got.Source != tc.identity.Source || got.IsPrimary != tc.identity.IsPrimary || got.Handle != "alice" {
			t.Fatalf("result = %+v, want source %q isPrimary %v", got, tc.identity.Source, tc.identity.IsPrimary)
		}
		human, err := runSignet(t, "whoami", "--url", srv.URL, "--source", "alice")
		if err != nil || !strings.Contains(human, tc.human) {
			t.Fatalf("human output lacks %q (err %v):\n%s", tc.human, err, human)
		}
		if n := log.byPath["/api/v1/lookup/"+aliceKey]; n != 2 {
			t.Fatalf("asked the v1 lookup %d times, want 2: %v", n, log.byPath)
		}
	}
}
