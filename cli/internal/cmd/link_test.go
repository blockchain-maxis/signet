package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/link"
)

const validPublicKey = "GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"

func TestLinkJSONWritesExactlyOneJSONObjectToStdout(t *testing.T) {
	isolateConfigDir(t)

	root := newRootCmd("dev", "none")
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetArgs([]string{"link", "aquawolf", "--public-key", validPublicKey, "--json"})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if stderr.Len() != 0 {
		t.Fatalf("--json run wrote to stderr: %q", stderr.String())
	}

	var got link.Result
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("stdout is not valid JSON: %v\nstdout was: %q", err, stdout.String())
	}
	want := link.Result{Handle: "aquawolf", PublicKey: validPublicKey, Network: "testnet", Status: "ok"}
	if got != want {
		t.Fatalf("decoded stdout = %+v, want %+v", got, want)
	}

	// "a single JSON object... and nothing else": exactly one line, no
	// decorative text before or after it.
	if lines := strings.Count(strings.TrimRight(stdout.String(), "\n"), "\n"); lines != 0 {
		t.Fatalf("stdout has more than one line: %q", stdout.String())
	}
}

func TestLinkJSONRespectsTheNetworkFlag(t *testing.T) {
	isolateConfigDir(t)

	root := newRootCmd("dev", "none")
	stdout := &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"link", "aquawolf", "--public-key", validPublicKey, "--network", "mainnet", "--json"})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	var got link.Result
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("stdout is not valid JSON: %v", err)
	}
	if got.Network != "mainnet" {
		t.Fatalf("Network = %q, want %q", got.Network, "mainnet")
	}
}

func TestLinkWithoutJSONPrintsAHumanSummaryNotJSON(t *testing.T) {
	isolateConfigDir(t)

	root := newRootCmd("dev", "none")
	stdout := &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"link", "aquawolf", "--public-key", validPublicKey})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	out := stdout.String()
	if !strings.Contains(out, "aquawolf") || !strings.Contains(out, validPublicKey) {
		t.Fatalf("human summary missing expected content: %q", out)
	}
	var discard link.Result
	if err := json.Unmarshal([]byte(out), &discard); err == nil {
		t.Fatalf("non-json output parsed as JSON, want a human summary: %q", out)
	}
}

func TestLinkRejectsAnInvalidPublicKeyAndWritesNothingToStdout(t *testing.T) {
	isolateConfigDir(t)

	root := newRootCmd("dev", "none")
	stdout := &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"link", "aquawolf", "--public-key", "not-a-key", "--json"})

	err := root.Execute()
	if err == nil {
		t.Fatal("Execute succeeded, want an error for an invalid public key")
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should stay empty on error, got: %q", stdout.String())
	}
}
