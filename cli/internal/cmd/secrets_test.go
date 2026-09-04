package cmd

import (
	"bytes"
	"regexp"
	"testing"
)

// secretPattern matches a Stellar StrKey secret seed (S... ed25519 secret
// key) — the shape nothing this CLI does should ever print, to stdout,
// stderr, or an error string. Nothing here handles real key material yet
// (see internal/keys), but this is a regression guard for when it does.
var secretPattern = regexp.MustCompile(`\bS[A-Z2-7]{55}\b`)

// assertNoSecretShapedOutput fails t if either buffer contains something
// shaped like a Stellar secret key.
func assertNoSecretShapedOutput(t *testing.T, label string, stdout, stderr *bytes.Buffer) {
	t.Helper()
	if m := secretPattern.FindString(stdout.String()); m != "" {
		t.Fatalf("%s: a secret-shaped value reached stdout: %q", label, m)
	}
	if m := secretPattern.FindString(stderr.String()); m != "" {
		t.Fatalf("%s: a secret-shaped value reached stderr: %q", label, m)
	}
}

func TestNoSecretShapedValueEverReachesOutput(t *testing.T) {
	isolateConfigDir(t)

	// A deliberately secret-key-shaped string fed in as if it were a public
	// key, an identity name, or a URL — every place user-controlled input
	// flows through the command tree. None of these are valid inputs (the
	// pattern doesn't have a 'G' prefix where a public key is expected), so
	// each run is expected to fail; the only thing under test is that the
	// bogus value, and nothing resembling a real secret, ever appears in
	// what the CLI printed.
	poison := "SASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"

	cases := [][]string{
		{"link", "aquawolf", "--public-key", poison},
		{"link", "aquawolf", "--public-key", poison, "--json"},
		{"link", poison, "--public-key", "GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"},
		{"--source", poison},
		{"--url", poison, "link", "aquawolf", "--public-key", poison},
	}

	for _, args := range cases {
		root := newRootCmd("dev", "none")
		stdout := &bytes.Buffer{}
		stderr := &bytes.Buffer{}
		root.SetOut(stdout)
		root.SetErr(stderr)
		root.SetArgs(args)

		err := root.Execute()

		assertNoSecretShapedOutput(t, "args="+args[0], stdout, stderr)

		// The command tree runs with SilenceErrors, so a returned error never
		// reaches the buffers above — cmd/signet/main.go is what prints it, to
		// the process's real stderr. Checking only the buffers would therefore
		// pass even if the message echoed the value straight back, so the
		// error string is asserted separately. This is the case that matters:
		// a user who puts a secret seed in --public-key by mistake must not
		// have it read back to them (and into their shell history and CI log).
		if err != nil {
			if m := secretPattern.FindString(err.Error()); m != "" {
				t.Fatalf("args=%v: a secret-shaped value reached the error string: %q", args, m)
			}
		}
	}
}
