package cmd

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/config"
)

func TestPromptForIdentity_SelectsByNumber(t *testing.T) {
	in := strings.NewReader("2\n")
	out := &bytes.Buffer{}
	prompt := promptForIdentity(in, out)

	got, err := prompt([]string{"alice", "bob"})
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if got != "bob" {
		t.Fatalf("got %q, want %q", got, "bob")
	}
	if !strings.Contains(out.String(), "1) alice") || !strings.Contains(out.String(), "2) bob") {
		t.Fatalf("menu not printed: %q", out.String())
	}
}

func TestPromptForIdentity_SelectsByName(t *testing.T) {
	in := strings.NewReader("alice\n")
	out := &bytes.Buffer{}
	prompt := promptForIdentity(in, out)

	got, err := prompt([]string{"alice", "bob"})
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if got != "alice" {
		t.Fatalf("got %q, want %q", got, "alice")
	}
}

func TestPromptForIdentity_RejectsOutOfRangeSelection(t *testing.T) {
	in := strings.NewReader("99\n")
	prompt := promptForIdentity(in, &bytes.Buffer{})

	if _, err := prompt([]string{"alice", "bob"}); err == nil {
		t.Fatal("expected an error for an out-of-range selection")
	}
}

func TestPromptForIdentity_RejectsEmptyInput(t *testing.T) {
	in := strings.NewReader("")
	prompt := promptForIdentity(in, &bytes.Buffer{})

	if _, err := prompt([]string{"alice", "bob"}); err == nil {
		t.Fatal("expected an error when no line is available to read")
	}
}

func TestIdentityCmd_HelpMentionsSourceFlag(t *testing.T) {
	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetArgs([]string{"identity", "--help"})

	if err := root.Execute(); err != nil {
		t.Fatalf("identity --help returned an error: %v", err)
	}
	if !strings.Contains(out.String(), "--source") {
		t.Fatalf("identity --help does not document --source: %q", out.String())
	}
}

// goToolEnv pins the go tool's cache and config locations to where they were
// before any test ran. isolateConfigDir moves HOME (macOS resolves the config
// dir from it) and AppData; left alone, the `go build` below would then look
// for its build and module caches under the empty temp dir and rebuild, and
// re-download dependencies, from scratch. Captured at package init, which
// runs before any test can change the environment.
var goToolEnv = func() []string {
	vars := []string{"GOCACHE", "GOMODCACHE", "GOPATH", "GOENV"}
	out, err := exec.Command("go", append([]string{"env"}, vars...)...).Output()
	if err != nil {
		return nil
	}
	values := strings.Split(strings.TrimRight(string(out), "\r\n"), "\n")
	if len(values) != len(vars) {
		return nil
	}
	env := make([]string, len(vars))
	for i, v := range vars {
		env[i] = v + "=" + strings.TrimRight(values[i], "\r")
	}
	return env
}()

// buildFakeStellarOnPath compiles internal/keys/testdata/fakestellar into a
// temp dir as `stellar`, prepends that dir to PATH, and returns — so
// keys.ResolvePublicKey's shell-out hits the fake exactly as it would the
// real CLI. Per-test (not sync.Once-cached like the keys package's copy):
// the cmd package has few tests that need it, and t.Setenv scopes the PATH
// change to each one.
func buildFakeStellarOnPath(t *testing.T) {
	t.Helper()
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skipf("go binary not found: %v", err)
	}
	dir := t.TempDir()
	name := "stellar"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	out := filepath.Join(dir, name)
	cmd := exec.Command(goBin, "build", "-o", out, "../keys/testdata/fakestellar")
	cmd.Env = append(os.Environ(), goToolEnv...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building fakestellar: %v\n%s", err, output)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// #595: `signet identity` must honour the resolved configuration like every
// other command — the remembered config-file source first.
func TestIdentityCmd_UsesTheRememberedSource(t *testing.T) {
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	if err := config.Save(config.File{Source: "alice"}); err != nil {
		t.Fatalf("seeding config file: %v", err)
	}

	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	// No stdin wired: a prompt would fail loudly instead of hanging —
	// resolving "alice" must not prompt at all.
	root.SetIn(strings.NewReader(""))
	root.SetArgs([]string{"identity"})

	if err := root.Execute(); err != nil {
		t.Fatalf("identity with a remembered source returned an error: %v", err)
	}
	if !strings.Contains(out.String(), "identity: alice") {
		t.Fatalf("remembered source not used: %q", out.String())
	}
}

// And the environment variable outranks the file, same as root.go resolves
// it for every other command.
func TestIdentityCmd_EnvSignWithKeyOverridesTheFile(t *testing.T) {
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	if err := config.Save(config.File{Source: "alice"}); err != nil {
		t.Fatalf("seeding config file: %v", err)
	}
	t.Setenv("STELLAR_SIGN_WITH_KEY", "bob")

	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetIn(strings.NewReader(""))
	root.SetArgs([]string{"identity"})

	if err := root.Execute(); err != nil {
		t.Fatalf("identity with STELLAR_SIGN_WITH_KEY returned an error: %v", err)
	}
	if !strings.Contains(out.String(), "identity: bob") {
		t.Fatalf("STELLAR_SIGN_WITH_KEY not honoured: %q", out.String())
	}
}
