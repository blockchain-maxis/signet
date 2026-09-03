package keys

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

func TestParseSemver(t *testing.T) {
	cases := []struct {
		in   string
		want semver
		ok   bool
	}{
		{"stellar 25.2.0\n", semver{25, 2, 0}, true},
		{"25.2.0", semver{25, 2, 0}, true},
		{"stellar-cli 22.0.1 (abcdef1)", semver{22, 0, 1}, true},
		{"no version here", semver{}, false},
	}
	for _, c := range cases {
		got, ok := parseSemver(c.in)
		if ok != c.ok {
			t.Fatalf("parseSemver(%q) ok = %v, want %v", c.in, ok, c.ok)
		}
		if ok && got != c.want {
			t.Fatalf("parseSemver(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestSemverCompare(t *testing.T) {
	cases := []struct {
		a, b semver
		want int
	}{
		{semver{25, 2, 0}, semver{25, 2, 0}, 0},
		{semver{25, 2, 1}, semver{25, 2, 0}, 1},
		{semver{25, 1, 9}, semver{25, 2, 0}, -1},
		{semver{26, 0, 0}, semver{25, 2, 0}, 1},
		{semver{24, 9, 9}, semver{25, 2, 0}, -1},
	}
	for _, c := range cases {
		if got := c.a.compare(c.b); got != c.want {
			t.Fatalf("%v.compare(%v) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCheckStellarCLIAcceptsTheMinimumVersion(t *testing.T) {
	bin := buildFakeStellar(t)
	t.Setenv("FAKESTELLAR_VERSION", MinimumStellarVersion)

	if err := CheckStellarCLI(bin); err != nil {
		t.Fatalf("CheckStellarCLI: %v", err)
	}
}

func TestCheckStellarCLIAcceptsANewerVersion(t *testing.T) {
	bin := buildFakeStellar(t)
	t.Setenv("FAKESTELLAR_VERSION", "26.0.0")

	if err := CheckStellarCLI(bin); err != nil {
		t.Fatalf("CheckStellarCLI: %v", err)
	}
}

func TestCheckStellarCLIRejectsATooOldVersion(t *testing.T) {
	bin := buildFakeStellar(t)
	t.Setenv("FAKESTELLAR_VERSION", "24.0.0")

	err := CheckStellarCLI(bin)
	if err == nil {
		t.Fatal("CheckStellarCLI succeeded with a version older than the minimum")
	}
	if !errors.Is(err, ErrStellarTooOld) {
		t.Fatalf("error does not wrap ErrStellarTooOld: %v", err)
	}
	// Actionable: names both what's required and where to get it.
	if !containsAll(err.Error(), MinimumStellarVersion, StellarInstallURL) {
		t.Fatalf("error is not actionable, missing version or install URL: %v", err)
	}
}

func TestCheckStellarCLIReportsAMissingBinaryDistinctly(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "definitely-not-a-real-binary")

	err := CheckStellarCLI(missing)
	if err == nil {
		t.Fatal("CheckStellarCLI succeeded with a nonexistent binary")
	}
	if !errors.Is(err, ErrStellarNotFound) {
		t.Fatalf("error does not wrap ErrStellarNotFound: %v", err)
	}
	if !containsAll(err.Error(), StellarInstallURL) {
		t.Fatalf("error is not actionable, missing the install URL: %v", err)
	}
}

func TestCheckStellarCLIDistinguishesMissingFromTooOld(t *testing.T) {
	bin := buildFakeStellar(t)
	t.Setenv("FAKESTELLAR_VERSION", "24.0.0")
	tooOldErr := CheckStellarCLI(bin)

	missingErr := CheckStellarCLI(filepath.Join(t.TempDir(), "nope"))

	if errors.Is(tooOldErr, ErrStellarNotFound) {
		t.Fatal("a too-old version was misclassified as not-found")
	}
	if errors.Is(missingErr, ErrStellarTooOld) {
		t.Fatal("a missing binary was misclassified as too-old")
	}
}

func containsAll(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}

// The checks above prove CheckStellarCLI itself works. These prove it is
// actually reached: issue #297 asks for the version check to happen *before
// any work*, and a guard nothing calls satisfies none of that. ResolvePublicKey
// is the function that shells out to `stellar`, so the guard runs there and
// every caller inherits it.

func TestResolvePublicKeyRefusesATooOldStellar(t *testing.T) {
	bin := buildFakeStellar(t)
	t.Setenv("FAKESTELLAR_VERSION", "24.0.0")

	// "alice" is an identity the fake resolves happily — so if this succeeds,
	// the version guard was skipped rather than the identity being at fault.
	_, err := ResolvePublicKey(bin, "alice")
	if err == nil {
		t.Fatal("ResolvePublicKey succeeded against a too-old stellar CLI; the version guard did not run")
	}
	if !errors.Is(err, ErrStellarTooOld) {
		t.Fatalf("ResolvePublicKey error = %v, want one wrapping ErrStellarTooOld", err)
	}
}

func TestResolvePublicKeyReportsAMissingStellarDistinctly(t *testing.T) {
	_, err := ResolvePublicKey(filepath.Join(t.TempDir(), "definitely-not-installed"), "alice")
	if !errors.Is(err, ErrStellarNotFound) {
		t.Fatalf("ResolvePublicKey error = %v, want one wrapping ErrStellarNotFound", err)
	}
}

func TestResolvePublicKeyStillWorksOnASupportedStellar(t *testing.T) {
	bin := buildFakeStellar(t)
	t.Setenv("FAKESTELLAR_VERSION", MinimumStellarVersion)

	got, err := ResolvePublicKey(bin, "alice")
	if err != nil {
		t.Fatalf("ResolvePublicKey: %v", err)
	}
	if want := "GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"; got != want {
		t.Fatalf("ResolvePublicKey = %q, want %q", got, want)
	}
}

func TestCheckStellarCLIBothFailureModesCarryTheConfigurationCode(t *testing.T) {
	bin := buildFakeStellar(t)
	t.Setenv("FAKESTELLAR_VERSION", "24.0.0")

	if err := CheckStellarCLI(bin); !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("too-old error does not wrap exitcode.ErrConfiguration: %v", err)
	}
	if err := CheckStellarCLI(filepath.Join(t.TempDir(), "nope")); !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("missing-binary error does not wrap exitcode.ErrConfiguration: %v", err)
	}
}
