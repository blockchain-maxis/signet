package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
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

// passiveDeps returns Deps whose update check reads and writes a temporary
// cache seeded with latest, and whose release lookup never reaches the
// network: it counts its calls and returns fetchErr (or latest).
func passiveDeps(t *testing.T, latest string, fetchErr error) (Deps, string, *int) {
	t.Helper()
	dir := t.TempDir()
	if latest != "" {
		if err := updatecheck.WriteCache(dir, &updatecheck.Cache{CheckedAt: time.Now(), Latest: latest}); err != nil {
			t.Fatalf("WriteCache: %v", err)
		}
	}
	calls := 0
	deps := defaultDeps()
	deps.UpdateCacheDir = func() (string, error) { return dir, nil }
	deps.FetchLatestRelease = func(context.Context, string) (*updatecheck.ReleaseInfo, error) {
		calls++
		if fetchErr != nil {
			return nil, fetchErr
		}
		return &updatecheck.ReleaseInfo{Version: latest, TagName: "cli-v" + latest}, nil
	}
	return deps, dir, &calls
}

// runForNotice runs `signet <args>` through Run and returns its stderr.
func runForNotice(t *testing.T, version string, deps Deps, args ...string) string {
	t.Helper()
	root := newRootCmdWithDeps(version, "abc1234", deps)
	errOut := &bytes.Buffer{}
	root.SetOut(&bytes.Buffer{})
	root.SetErr(errOut)
	root.SetArgs(args)
	if err := Run(root); err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	return errOut.String()
}

const noticePrefix = "A new release of signet is available"

func TestPassiveNoticeSkippedUnderJSON(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")
	deps, _, calls := passiveDeps(t, "2.0.0", nil)

	if got := runForNotice(t, "1.0.0", deps, "version", "--json"); strings.Contains(got, noticePrefix) {
		t.Fatalf("expected no passive notice under --json, got: %s", got)
	}
	if *calls != 0 {
		t.Fatalf("release lookup ran %d times under --json", *calls)
	}
}

func TestPassiveNoticeSkippedUnderCI(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "1")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")
	deps, _, _ := passiveDeps(t, "2.0.0", nil)

	if got := runForNotice(t, "1.0.0", deps, "version"); strings.Contains(got, noticePrefix) {
		t.Fatalf("expected no passive notice with CI=1, got: %s", got)
	}
}

func TestPassiveNoticeSkippedWithOptOut(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "1")
	deps, _, _ := passiveDeps(t, "2.0.0", nil)

	if got := runForNotice(t, "1.0.0", deps, "version"); strings.Contains(got, noticePrefix) {
		t.Fatalf("expected no passive notice with SIGNET_NO_UPDATE_CHECK=1, got: %s", got)
	}
}

func TestPassiveNoticeSkippedForDevBuild(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")
	deps, _, _ := passiveDeps(t, "2.0.0", nil)

	if got := runForNotice(t, "dev", deps, "version"); strings.Contains(got, noticePrefix) {
		t.Fatalf("expected no passive notice for dev build, got: %s", got)
	}
}

func TestPassiveNoticePrintedOnTerminalWhenUpdateAvailable(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")
	deps, _, calls := passiveDeps(t, "2.0.0", nil)

	got := runForNotice(t, "1.0.0", deps, "version")
	if !strings.Contains(got, noticePrefix+": 1.0.0 -> 2.0.0") {
		t.Fatalf("expected passive notice on terminal, got: %s", got)
	}
	if *calls != 0 {
		t.Fatalf("fresh cache should not trigger a release lookup, got %d", *calls)
	}

	// At most once per 24h: the next command stays quiet.
	if got := runForNotice(t, "1.0.0", deps, "version"); strings.Contains(got, noticePrefix) {
		t.Fatalf("notice printed twice within 24h: %s", got)
	}
}

func TestPassiveCheckCachesFailedLookup(t *testing.T) {
	fakeTerminal(t)
	t.Setenv("CI", "")
	t.Setenv("SIGNET_NO_UPDATE_CHECK", "")
	deps, dir, calls := passiveDeps(t, "", errors.New("offline"))

	for i := 0; i < 3; i++ {
		if got := runForNotice(t, "1.0.0", deps, "version"); strings.Contains(got, noticePrefix) {
			t.Fatalf("run %d: unexpected notice: %s", i, got)
		}
	}
	if *calls != 1 {
		t.Fatalf("an offline machine should look up releases once a day, got %d lookups", *calls)
	}
	c, err := updatecheck.ReadCache(dir)
	if err != nil || !c.Failed {
		t.Fatalf("expected a cached failure, got %+v (%v)", c, err)
	}
}

func fakeTerminal(t *testing.T) {
	t.Helper()
	prev := writerIsTerminal
	writerIsTerminal = func(w io.Writer) bool { return true }
	t.Cleanup(func() { writerIsTerminal = prev })
}
