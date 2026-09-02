package keys

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// buildFakeStellar compiles testdata/fakestellar once per test run (guarded
// by sync.Once so parallel/subsequent tests reuse the same binary) and
// returns its path — a real, faked `stellar` binary that ResolvePublicKey
// shells out to exactly as it would the genuine CLI, per #290's "identity
// resolution against a faked stellar binary" requirement.
var (
	fakeStellarOnce sync.Once
	fakeStellarPath string
	fakeStellarErr  error
)

func buildFakeStellar(t *testing.T) string {
	t.Helper()
	fakeStellarOnce.Do(func() {
		goBin, err := exec.LookPath("go")
		if err != nil {
			fakeStellarErr = err
			return
		}
		dir := t.TempDir()
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
