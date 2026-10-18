package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
)

// isolateDirs points both the config and the cache directory at fresh temp
// directories for the test, on every OS, so `bug-report` cannot read or write
// the real developer's state.
func isolateDirs(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	t.Setenv("HOME", dir)
	t.Setenv("AppData", dir)
	t.Setenv("LocalAppData", dir)
}

// buildRoot builds the real command tree with a `stellar` binary that does not
// exist, so the environment checks are deterministic and touch no network.
func buildRoot(t *testing.T) (root *cobra.Command, stdout, stderr *bytes.Buffer) {
	t.Helper()
	deps := defaultDeps()
	deps.KeysBinary = "/nonexistent/signet-test-stellar"
	root = newRootCmdWithDeps("1.2.3", "abc1234", deps)
	stdout, stderr = &bytes.Buffer{}, &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetIn(strings.NewReader(""))
	return root, stdout, stderr
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestGenericErrorIsRecordedAndIncludedInTheBugReport(t *testing.T) {
	isolateDirs(t)

	// A generic error: not in the exit-code taxonomy, so it maps to exit 1.
	failing := &cobra.Command{Use: "failing", SilenceUsage: true, SilenceErrors: true}
	failing.RunE = func(*cobra.Command, []string) error {
		return fmt.Errorf("boom: %s", secretCanary)
	}
	// Execute reads os.Args when no args are set, which under `go test` are the
	// test binary's own flags; set them explicitly so the RunE is what runs.
	failing.SetArgs([]string{})
	if err := Run(failing); err == nil {
		t.Fatal("the failing command returned no error")
	}

	recorded, err := readLastError()
	if err != nil {
		t.Fatalf("readLastError: %v", err)
	}
	if recorded == nil {
		t.Fatal("a generic error did not write last-error.json")
	}
	if strings.Contains(recorded.Message, secretCanary) {
		t.Fatalf("the recorded error kept a secret: %q", recorded.Message)
	}
	if !strings.Contains(recorded.Message, "boom") {
		t.Fatalf("the recorded error lost its text: %q", recorded.Message)
	}

	root, stdout, stderr := buildRoot(t)
	root.SetArgs([]string{"bug-report"})
	if err := root.Execute(); err != nil {
		t.Fatalf("bug-report: %v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, "last error:") || !strings.Contains(out, "boom") {
		t.Fatalf("the report does not include the recorded error:\n%s", out)
	}
	if !strings.Contains(out, issuesNewURL) {
		t.Fatalf("the report does not include the pre-filled issue URL:\n%s", out)
	}
	if strings.Contains(out, secretCanary) {
		t.Fatalf("the report leaked the secret:\n%s", out)
	}
	assertNoSecretShapedOutput(t, stdout, stderr, nil)
}

func TestBugReportMakesNoNetworkRequests(t *testing.T) {
	isolateDirs(t)

	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	used := false
	http.DefaultTransport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		used = true
		return nil, errors.New("network access attempted")
	})

	root, stdout, _ := buildRoot(t)
	root.SetArgs([]string{"bug-report"})
	if err := root.Execute(); err != nil {
		t.Fatalf("bug-report: %v", err)
	}
	if used {
		t.Fatal("bug-report attempted a network request")
	}
	if !strings.Contains(stdout.String(), issuesNewURL) {
		t.Fatalf("the report does not include the issue URL:\n%s", stdout.String())
	}
}

func TestBugReportShowsOnlyTheCustomURLHost(t *testing.T) {
	isolateDirs(t)
	if err := config.Save(config.File{BaseURL: "https://signet.example.com/secret/path?token=abc"}); err != nil {
		t.Fatalf("seed config file: %v", err)
	}

	root, stdout, _ := buildRoot(t)
	root.SetArgs([]string{"bug-report"})
	if err := root.Execute(); err != nil {
		t.Fatalf("bug-report: %v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, "custom (signet.example.com)") {
		t.Fatalf("the report does not name the custom host:\n%s", out)
	}
	if strings.Contains(out, "secret") || strings.Contains(out, "token=abc") {
		t.Fatalf("the report leaked the URL path or query:\n%s", out)
	}
}

func TestDoctorReportsAMissingStellarBinaryWithoutFailing(t *testing.T) {
	isolateDirs(t)

	root, stdout, stderr := buildRoot(t)
	root.SetArgs([]string{"doctor", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatalf("doctor: %v", err)
	}

	var got doctorResult
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("doctor --json is not a single JSON object: %v\n%s", err, stdout.String())
	}
	var stellar *doctorCheck
	for i := range got.Checks {
		if got.Checks[i].Name == "stellar CLI" {
			stellar = &got.Checks[i]
		}
	}
	if stellar == nil {
		t.Fatal("doctor reported no stellar CLI check")
	}
	if stellar.OK {
		t.Fatalf("the stellar check passed with a nonexistent binary: %+v", *stellar)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}
