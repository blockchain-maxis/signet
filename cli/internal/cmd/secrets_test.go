package cmd

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

const (
	secretCanary = "SASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"
	publicKey    = "GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"
)

// secretPattern matches a Stellar StrKey secret seed (S... ed25519 secret
// key) — the shape nothing this CLI does should ever print, to stdout,
// stderr, or an error string.
var secretPattern = regexp.MustCompile(`\bS[A-Z2-7]{55}\b`)

func installFakeStellar(t *testing.T) {
	t.Helper()
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("find go binary: %v", err)
	}

	dir := t.TempDir()
	bin := filepath.Join(dir, "stellar")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command(goBin, "build", "-o", bin, "../keys/testdata/fakestellar")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake stellar: %v: %s", err, output)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func assertNoSecretShapedOutput(t *testing.T, stdout, stderr *bytes.Buffer, err error) {
	t.Helper()
	for label, value := range map[string]string{
		"stdout": stdout.String(),
		"stderr": stderr.String(),
		"error":  errorString(err),
	} {
		if match := secretPattern.FindString(value); match != "" {
			t.Fatalf("a secret-shaped value reached %s: %q", label, match)
		}
	}
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func assertPastCobraParsing(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		return
	}
	for _, parsingError := range []string{"unknown flag", "unknown command", "accepts 0 arg(s)"} {
		if strings.Contains(err.Error(), parsingError) {
			t.Fatalf("case stopped in cobra parsing (%q): %v", parsingError, err)
		}
	}
}

func TestNoSecretShapedValueEverReachesOutput(t *testing.T) {
	isolateConfigDir(t)
	// os.UserConfigDir uses HOME directly on macOS instead of either variable
	// isolateConfigDir sets for Unix/Windows.
	t.Setenv("HOME", t.TempDir())
	installFakeStellar(t)

	// The link URL case must reach the approval sink before it fails. A real
	// start followed by a rejected status does that without opening a browser.
	rejectServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/api/cli/pair/start"):
			_, _ = fmt.Fprint(w, `{"state":"state","pollToken":"token"}`)
		case strings.HasSuffix(r.URL.Path, "/api/cli/pair/status"):
			_, _ = fmt.Fprint(w, `{"status":"rejected"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(rejectServer.Close)

	// Successful whoami/unlink responses exercise the real output fields. The
	// same server also lets the signing-stderr case reach stellar tx sign.
	successServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/api/auth/sep10"):
			_, _ = fmt.Fprint(w, `{"transaction":"AAAAunsignedChallengeEnvelopeAAAA","network_passphrase":"Test SDF Network ; September 2015"}`)
		case strings.HasSuffix(r.URL.Path, "/api/cli/unlink"):
			_, _ = fmt.Fprintf(w, `{"wallet":%q,"handle":%q}`, secretCanary, secretCanary)
		case strings.HasSuffix(r.URL.Path, "/api/cli/whoami"):
			_, _ = fmt.Fprintf(w, `{"publicKey":%q,"handle":%q,"linked":true,"network":"testnet"}`, publicKey, secretCanary)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(successServer.Close)

	rejectPoisonURL := rejectServer.URL + "/" + secretCanary
	successPoisonURL := successServer.URL + "/" + secretCanary
	tests := []struct {
		name          string
		args          []string
		envSignWith   string
		addressOutput string
		signStderr    string
		signStdout    string
		remembered    string
		wantError     string
		wantStdout    []string
		wantSuccess   bool
	}{
		{name: "link --sign-with-key", args: []string{"link", "--sign-with-key", secretCanary, "--url", rejectServer.URL}, wantError: "looks like key material"},
		{name: "unlink --sign-with-key", args: []string{"unlink", "--yes", "--sign-with-key", secretCanary, "--url", successServer.URL}, wantError: "looks like key material"},
		{name: "whoami --sign-with-key", args: []string{"whoami", "--sign-with-key", secretCanary, "--url", successServer.URL}, wantError: "looks like key material"},
		{name: "explicit empty --sign-with-key", args: []string{"whoami", "--sign-with-key", "", "--url", successServer.URL}, wantError: "--sign-with-key was given an empty value"},
		{name: "link STELLAR_SIGN_WITH_KEY", args: []string{"link", "--url", rejectServer.URL}, envSignWith: secretCanary, wantError: "looks like key material"},
		{name: "unlink STELLAR_SIGN_WITH_KEY", args: []string{"unlink", "--yes", "--url", successServer.URL}, envSignWith: secretCanary, wantError: "looks like key material"},
		{name: "whoami STELLAR_SIGN_WITH_KEY", args: []string{"whoami", "--url", successServer.URL}, envSignWith: secretCanary, wantError: "looks like key material"},
		{name: "link --source", args: []string{"link", "--source", secretCanary, "--url", rejectServer.URL}, wantError: "looks like key material"},
		{name: "unlink --source", args: []string{"unlink", "--yes", "--source", secretCanary, "--url", successServer.URL}, wantError: "looks like key material"},
		{name: "whoami --source", args: []string{"whoami", "--source", secretCanary, "--url", successServer.URL}, wantError: "looks like key material"},
		{name: "link --url", args: []string{"link", "--no-browser", "--source", "alice", "--url", rejectPoisonURL}, addressOutput: publicKey, wantError: "approval was refused", wantStdout: []string{"Approve this link", redact.Placeholder}},
		{name: "unlink --url", args: []string{"unlink", "--yes", "--source", "alice", "--url", successPoisonURL}, addressOutput: publicKey, signStdout: "AAAAAgAAAABxdnhrZmFrZXNpZ25lZGVudmVsb3BlAAAAAAAAZA==", wantStdout: []string{"Unlinked", redact.Placeholder}, wantSuccess: true},
		{name: "whoami --url", args: []string{"whoami", "--source", "alice", "--url", successPoisonURL}, addressOutput: publicKey, wantStdout: []string{"deployment:", redact.Placeholder}, wantSuccess: true},
		{name: "stellar keys address stdout", args: []string{"whoami", "--source", "alice", "--url", successServer.URL}, addressOutput: secretCanary, wantError: "isn't a Stellar public key"},
		{name: "stellar tx sign stderr", args: []string{"unlink", "--yes", "--source", "alice", "--url", successServer.URL}, addressOutput: publicKey, signStderr: "hardware wallet refused seed " + secretCanary, wantError: "hardware wallet refused seed " + redact.Placeholder},
		{name: "remembered signing identity", args: []string{"whoami", "--url", successServer.URL}, remembered: secretCanary, wantError: "looks like key material"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(config.EnvSignWithKey, tt.envSignWith)
			t.Setenv("FAKESTELLAR_ADDRESS_OUTPUT", tt.addressOutput)
			t.Setenv("FAKESTELLAR_SIGN_STDERR", tt.signStderr)
			t.Setenv("FAKESTELLAR_SIGN_STDOUT", tt.signStdout)
			if tt.remembered != "" {
				if err := config.Save(config.File{Source: tt.remembered}); err != nil {
					t.Fatalf("seed remembered identity: %v", err)
				}
			}

			root := newRootCmd("dev", "none")
			stdout := &bytes.Buffer{}
			stderr := &bytes.Buffer{}
			root.SetOut(stdout)
			root.SetErr(stderr)
			root.SetArgs(tt.args)

			err := root.Execute()
			assertPastCobraParsing(t, err)
			if tt.wantSuccess && err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if !tt.wantSuccess && err == nil {
				t.Fatal("case unexpectedly succeeded")
			}
			if tt.wantError != "" && !strings.Contains(errorString(err), tt.wantError) {
				t.Fatalf("error = %q, want evidence that the case reached %q", err, tt.wantError)
			}
			for _, want := range tt.wantStdout {
				if !strings.Contains(stdout.String(), want) {
					t.Fatalf("stdout = %q, want %q", stdout.String(), want)
				}
			}
			assertNoSecretShapedOutput(t, stdout, stderr, err)
		})
	}
}
