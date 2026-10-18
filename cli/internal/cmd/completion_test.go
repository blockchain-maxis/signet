package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/config"
)

func TestCompleteSourceFlagWithFakeStellar(t *testing.T) {
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	t.Setenv("FAKESTELLAR_IDENTITIES", "alice\nbob")

	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"__complete", "link", "--source", ""})

	if err := root.Execute(); err != nil {
		t.Fatalf("__complete link --source returned an error: %v", err)
	}

	got := out.String()
	for _, want := range []string{"alice", "bob"} {
		if !strings.Contains(got, want+"\n") {
			t.Fatalf("__complete link --source output = %q, missing identity %q", got, want)
		}
	}
}

func TestCompleteSignWithKeyFlagWithFakeStellar(t *testing.T) {
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	t.Setenv("FAKESTELLAR_IDENTITIES", "alice\nbob")

	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"__complete", "link", "--sign-with-key", ""})

	if err := root.Execute(); err != nil {
		t.Fatalf("__complete link --sign-with-key returned an error: %v", err)
	}

	got := out.String()
	for _, want := range []string{"alice", "bob"} {
		if !strings.Contains(got, want+"\n") {
			t.Fatalf("__complete link --sign-with-key output = %q, missing identity %q", got, want)
		}
	}
}

func TestCompleteContextFlagAndContextUseFromConfig(t *testing.T) {
	isolateConfigDir(t)
	err := config.Save(config.File{
		Current: "staging",
		Contexts: map[string]config.Context{
			"staging": {URL: "https://staging.signet.example", Network: "testnet"},
			"prod":    {URL: "https://signet.example", Network: "mainnet"},
		},
	})
	if err != nil {
		t.Fatalf("seeding config file: %v", err)
	}

	for _, args := range [][]string{
		{"__complete", "link", "--context", ""},
		{"__complete", "context", "use", ""},
		{"__complete", "context", "show", ""},
		{"__complete", "context", "remove", ""},
	} {
		root := newRootCmd("dev", "none")
		out := &bytes.Buffer{}
		root.SetOut(out)
		root.SetErr(&bytes.Buffer{})
		root.SetArgs(args)

		if err := root.Execute(); err != nil {
			t.Fatalf("%v returned an error: %v", args, err)
		}

		got := out.String()
		for _, want := range []string{"prod", "staging"} {
			if !strings.Contains(got, want+"\n") {
				t.Fatalf("%v output = %q, missing context %q", args, got, want)
			}
		}
	}
}

func TestCompleteNetworkFlag(t *testing.T) {
	isolateConfigDir(t)

	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"__complete", "link", "--network", ""})

	if err := root.Execute(); err != nil {
		t.Fatalf("__complete link --network returned an error: %v", err)
	}

	got := out.String()
	for _, want := range []string{"testnet", "mainnet"} {
		if !strings.Contains(got, want+"\n") {
			t.Fatalf("__complete link --network output = %q, missing network %q", got, want)
		}
	}
}
