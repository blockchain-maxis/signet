package keys

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// buildFakeStellar compiles testdata/fakestellar once per test binary run
// (guarded by sync.Once) and returns its path — a real, faked `stellar`
// binary that ResolvePublicKey/CheckStellarCLI shell out to exactly as they
// would the genuine CLI, per #290's "identity resolution against a faked
// stellar binary" requirement.
//
// The build directory is a plain os.MkdirTemp, not t.TempDir(): t.TempDir()
// is removed as soon as the *specific test* that created it finishes, but
// this path is cached and reused across every other test in the package —
// using it here would delete the binary out from under every test after the
// first. TestMain below cleans the directory up once, at the end of the
// whole run.
var (
	fakeStellarOnce sync.Once
	fakeStellarDir  string
	fakeStellarPath string
	fakeStellarErr  error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if fakeStellarDir != "" {
		_ = os.RemoveAll(fakeStellarDir)
	}
	os.Exit(code)
}

func buildFakeStellar(t *testing.T) string {
	t.Helper()
	fakeStellarOnce.Do(func() {
		goBin, err := exec.LookPath("go")
		if err != nil {
			fakeStellarErr = err
			return
		}
		dir, err := os.MkdirTemp("", "fakestellar")
		if err != nil {
			fakeStellarErr = err
			return
		}
		fakeStellarDir = dir
		out := filepath.Join(dir, "stellar")
		if runtime.GOOS == "windows" {
			out += ".exe"
		}
		cmd := exec.Command(goBin, "build", "-o", out, "./testdata/fakestellar")
		if output, buildErr := cmd.CombinedOutput(); buildErr != nil {
			fakeStellarErr = fmt.Errorf("%w: %s", buildErr, output)
			return
		}
		fakeStellarPath = out
	})
	if fakeStellarErr != nil {
		t.Skipf("could not build the fake stellar binary: %v", fakeStellarErr)
	}
	return fakeStellarPath
}

func TestResolvePublicKeyAgainstAFakedStellarBinary(t *testing.T) {
	bin := buildFakeStellar(t)

	got, err := ResolvePublicKey(bin, "alice")
	if err != nil {
		t.Fatalf("ResolvePublicKey: %v", err)
	}
	want := "GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"
	if got != want {
		t.Fatalf("ResolvePublicKey() = %q, want %q", got, want)
	}
}

func TestResolvePublicKeyRejectsAnUnknownIdentity(t *testing.T) {
	bin := buildFakeStellar(t)

	_, err := ResolvePublicKey(bin, "missing")
	if err == nil {
		t.Fatal("ResolvePublicKey succeeded for an identity the fake CLI doesn't have")
	}
}

func TestResolvePublicKeyRejectsOutputThatIsNotAPublicKey(t *testing.T) {
	bin := buildFakeStellar(t)

	_, err := ResolvePublicKey(bin, "garbage")
	if err == nil {
		t.Fatal("ResolvePublicKey succeeded on malformed output from the CLI")
	}
}

func TestResolvePublicKeyReportsAMissingBinaryClearly(t *testing.T) {
	_, err := ResolvePublicKey(filepath.Join(t.TempDir(), "does-not-exist"), "alice")
	if err == nil {
		t.Fatal("ResolvePublicKey succeeded with a nonexistent binary")
	}
}

func TestResolvePublicKeyRequiresANonEmptySource(t *testing.T) {
	if _, err := ResolvePublicKey(DefaultBinary, ""); err == nil {
		t.Fatal("ResolvePublicKey succeeded with an empty identity name")
	}
}

func TestResolvePublicKeyUnknownIdentityCarriesTheNoIdentityCode(t *testing.T) {
	bin := buildFakeStellar(t)

	_, err := ResolvePublicKey(bin, "missing")
	if !errors.Is(err, exitcode.ErrNoIdentity) {
		t.Fatalf("error does not wrap exitcode.ErrNoIdentity: %v", err)
	}
}

func TestResolvePublicKeyMissingBinaryCarriesTheConfigurationCode(t *testing.T) {
	_, err := ResolvePublicKey(filepath.Join(t.TempDir(), "does-not-exist"), "alice")
	if !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("error does not wrap exitcode.ErrConfiguration: %v", err)
	}
}
