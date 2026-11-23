package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"

	updatecheck "github.com/blockchain-maxis/signet/cli/internal/update"
)

func TestVersionCheckJSONShape(t *testing.T) {
	// 1. With --check and update available
	deps := defaultDeps()
	deps.CheckUpdate = func(ctx context.Context, currentVersion string) (*updatecheck.CheckResult, error) {
		return &updatecheck.CheckResult{
			Current:         "1.0.0",
			Latest:          "1.2.0",
			UpdateAvailable: true,
			UpgradeCommand:  "npm install -g @signet/cli@latest",
		}, nil
	}

	root := newRootCmdWithDeps("1.0.0", "abc1234", deps)
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"version", "--check", "--json"})

	if err := root.Execute(); err != nil {
		t.Fatalf("version --check --json failed: %v", err)
	}

	var res map[string]any
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal json: %v\noutput: %s", err, out.String())
	}

	if res["version"] != "1.0.0" {
		t.Fatalf("expected version 1.0.0, got %v", res["version"])
	}
	if res["commit"] != "abc1234" {
		t.Fatalf("expected commit abc1234, got %v", res["commit"])
	}
	if res["latest"] != "1.2.0" {
		t.Fatalf("expected latest 1.2.0, got %v", res["latest"])
	}
	if res["updateAvailable"] != true {
		t.Fatalf("expected updateAvailable true, got %v", res["updateAvailable"])
	}

	// 2. Without --check: latest and updateAvailable must be omitted
	rootPlain := newRootCmdWithDeps("1.0.0", "abc1234", deps)
	outPlain := &bytes.Buffer{}
	rootPlain.SetOut(outPlain)
	rootPlain.SetErr(&bytes.Buffer{})
	rootPlain.SetArgs([]string{"version", "--json"})

	if err := rootPlain.Execute(); err != nil {
		t.Fatalf("version --json failed: %v", err)
	}

	var resPlain map[string]any
	if err := json.Unmarshal(outPlain.Bytes(), &resPlain); err != nil {
		t.Fatalf("unmarshal json: %v\noutput: %s", err, outPlain.String())
	}
	if _, ok := resPlain["latest"]; ok {
		t.Fatalf("latest should not be present without --check: %v", resPlain)
	}
	if _, ok := resPlain["updateAvailable"]; ok {
		t.Fatalf("updateAvailable should not be present without --check: %v", resPlain)
	}
}

func TestVersionCheckHumanOutput(t *testing.T) {
	deps := defaultDeps()
	deps.CheckUpdate = func(ctx context.Context, currentVersion string) (*updatecheck.CheckResult, error) {
		return &updatecheck.CheckResult{
			Current:         "1.0.0",
			Latest:          "1.2.0",
			UpdateAvailable: true,
			UpgradeCommand:  "npm install -g @signet/cli@latest",
		}, nil
	}

	root := newRootCmdWithDeps("1.0.0", "abc1234", deps)
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"version", "--check"})

	if err := root.Execute(); err != nil {
		t.Fatalf("version --check failed: %v", err)
	}

	s := out.String()
	if !strings.Contains(s, "signet version 1.0.0 (commit abc1234)") {
		t.Fatalf("missing version header: %s", s)
	}
	if !strings.Contains(s, "Latest release: 1.2.0") {
		t.Fatalf("missing latest release: %s", s)
	}
	if !strings.Contains(s, "Upgrade: npm install -g @signet/cli@latest") {
		t.Fatalf("missing upgrade command: %s", s)
	}
}

func TestVersionCheckFailurePrintsWarningAndExitsZero(t *testing.T) {
	deps := defaultDeps()
	deps.CheckUpdate = func(ctx context.Context, currentVersion string) (*updatecheck.CheckResult, error) {
		return nil, errors.New("network unreachable")
	}

	root := newRootCmdWithDeps("1.0.0", "abc1234", deps)
	out := &bytes.Buffer{}
	errOut := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(errOut)
	root.SetArgs([]string{"version", "--check"})

	if err := root.Execute(); err != nil {
		t.Fatalf("expected exit 0 on failed check, got: %v", err)
	}

	if !strings.Contains(errOut.String(), "warning: failed to check for updates: network unreachable") {
		t.Fatalf("expected warning on stderr, got: %s", errOut.String())
	}
	if !strings.Contains(out.String(), "signet version 1.0.0 (commit abc1234)") {
		t.Fatalf("expected version output on stdout, got: %s", out.String())
	}
}

func setTestCache(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", d)
	t.Setenv("LOCALAPPDATA", d)
	return filepath.Join(d, "signet")
}

func TestPassiveNoticeSkippedUnderJSON(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")

	signetCache := setTestCache(t)
	_ = updatecheck.WriteCache(signetCache, &updatecheck.Cache{
		CheckedAt: time.Now(),
		Latest:    "2.0.0",
	})

	root := newRootCmdWithDeps("1.0.0", "abc1234", defaultDeps())
	out := &bytes.Buffer{}
	errOut := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(errOut)
	root.SetArgs([]string{"version", "--json"})

	if err := Run(root); err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	if strings.Contains(errOut.String(), "A new release of signet is available") {
		t.Fatalf("expected no passive notice under --json, got: %s", errOut.String())
	}
}

func TestPassiveNoticeSkippedUnderCI(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "1")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")

	signetCache := setTestCache(t)
	_ = updatecheck.WriteCache(signetCache, &updatecheck.Cache{
		CheckedAt: time.Now(),
		Latest:    "2.0.0",
	})

	root := newRootCmdWithDeps("1.0.0", "abc1234", defaultDeps())
	out := &bytes.Buffer{}
	errOut := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(errOut)
	root.SetArgs([]string{"version"})

	if err := Run(root); err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	if strings.Contains(errOut.String(), "A new release of signet is available") {
		t.Fatalf("expected no passive notice with CI=1, got: %s", errOut.String())
	}
}

func TestPassiveNoticeSkippedForDevBuild(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")

	signetCache := setTestCache(t)
	_ = updatecheck.WriteCache(signetCache, &updatecheck.Cache{
		CheckedAt: time.Now(),
		Latest:    "2.0.0",
	})

	root := newRootCmdWithDeps("dev", "none", defaultDeps())
	out := &bytes.Buffer{}
	errOut := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(errOut)
	root.SetArgs([]string{"version"})

	if err := Run(root); err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	if strings.Contains(errOut.String(), "A new release of signet is available") {
		t.Fatalf("expected no passive notice for dev build, got: %s", errOut.String())
	}
}

func TestPassiveNoticePrintedOnTerminalWhenUpdateAvailable(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")

	signetCache := setTestCache(t)
	_ = updatecheck.WriteCache(signetCache, &updatecheck.Cache{
		CheckedAt: time.Now(),
		Latest:    "2.0.0",
	})

	root := newRootCmdWithDeps("1.0.0", "abc1234", defaultDeps())
	out := &bytes.Buffer{}
	errOut := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(errOut)
	root.SetArgs([]string{"version"})

	if err := Run(root); err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	if !strings.Contains(errOut.String(), "A new release of signet is available: 1.0.0 -> 2.0.0") {
		t.Fatalf("expected passive notice on terminal, got: %s", errOut.String())
	}
}

func fakeTerminal(t *testing.T) {
	t.Helper()
	prev := writerIsTerminal
	writerIsTerminal = func(w io.Writer) bool { return true }
	t.Cleanup(func() { writerIsTerminal = prev })
}
