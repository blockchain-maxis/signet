package keys

import (
	"errors"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const fakeSignedXDR = "AAAAAgAAAABxdnhrZmFrZXNpZ25lZGVudmVsb3BlAAAAAAAAZA=="

// withStdinRunner swaps the exec seam for the duration of a test.
func withStdinRunner(t *testing.T, fn stdinRunner) {
	t.Helper()
	previous := runStdin
	runStdin = fn
	t.Cleanup(func() { runStdin = previous })
}

func TestSignChallenge_PipesTheEnvelopeAndReturnsTheSignedOne(t *testing.T) {
	var gotStdin string
	var gotArgs []string
	withStdinRunner(t, func(_ string, stdin string, args ...string) ([]byte, []byte, error) {
		gotStdin = stdin
		gotArgs = args
		return []byte(fakeSignedXDR + "\n"), nil, nil
	})

	signed, err := SignChallenge(buildFakeStellar(t), "alice", "AAAAunsignedAAAA")
	if err != nil {
		t.Fatalf("SignChallenge: %v", err)
	}
	if signed != fakeSignedXDR {
		t.Fatalf("signed = %q, want the trimmed stdout", signed)
	}
	if gotStdin != "AAAAunsignedAAAA" {
		t.Fatalf("piped %q to stellar", gotStdin)
	}
	want := []string{"tx", "sign", "--sign-with-key", "alice"}
	if strings.Join(gotArgs, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v, want %v", gotArgs, want)
	}
}

func TestSignChallenge_SurfacesStellarsStderr(t *testing.T) {
	withStdinRunner(t, func(string, string, ...string) ([]byte, []byte, error) {
		return nil, []byte("error: identity 'alice' not found\n"), errors.New("exit status 1")
	})

	_, err := SignChallenge(buildFakeStellar(t), "alice", "AAAAunsignedAAAA")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("err is not a signing failure: %v", err)
	}
	// stellar's own message is the actionable part; don't replace it.
	if !strings.Contains(err.Error(), "identity 'alice' not found") {
		t.Fatalf("err lost stellar's stderr: %v", err)
	}
}

func TestSignChallenge_RejectsOutputThatIsNotAnEnvelope(t *testing.T) {
	withStdinRunner(t, func(string, string, ...string) ([]byte, []byte, error) {
		return []byte("Signing with alice... done!"), nil, nil
	})

	_, err := SignChallenge(buildFakeStellar(t), "alice", "AAAAunsignedAAAA")
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("accepted non-envelope output: %v", err)
	}
}

func TestSignChallenge_RejectsEmptyOutput(t *testing.T) {
	withStdinRunner(t, func(string, string, ...string) ([]byte, []byte, error) {
		return []byte("  \n"), nil, nil
	})

	_, err := SignChallenge(buildFakeStellar(t), "alice", "AAAAunsignedAAAA")
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("accepted empty output: %v", err)
	}
}

func TestSignChallenge_RequiresAnIdentityAndSomethingToSign(t *testing.T) {
	withStdinRunner(t, func(string, string, ...string) ([]byte, []byte, error) {
		t.Fatal("should not have shelled out")
		return nil, nil, nil
	})

	if _, err := SignChallenge("stellar", "", "AAAA"); !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("empty identity: %v", err)
	}
	if _, err := SignChallenge("stellar", "alice", "   "); !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("empty envelope: %v", err)
	}
}

func TestLooksLikeXDR(t *testing.T) {
	if !looksLikeXDR(fakeSignedXDR) {
		t.Fatal("rejected a base64 envelope")
	}
	for _, bad := range []string{
		"",
		"short",
		"has spaces in it but is quite long indeed",
		"contains\nnewline0000000000000000000000000",
		"not-base64-because-of-dashes-0000000000000",
	} {
		if looksLikeXDR(bad) {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// ── non-interactive signing (#254) ───────────────────────────────────────

func TestValidateSignWithKey_AcceptsAnIdentityName(t *testing.T) {
	for _, ok := range []string{"alice", "ci-deploy", "deploy_key_1"} {
		if err := ValidateSignWithKey(ok); err != nil {
			t.Fatalf("ValidateSignWithKey(%q) = %v", ok, err)
		}
	}
}

func TestValidateSignWithKey_RefusesKeyMaterial(t *testing.T) {
	secret := "S" + strings.Repeat("A", 55)
	phrase := "abandon ability able about above absent absorb abstract absurd abuse access accident"

	for _, bad := range []string{secret, phrase} {
		err := ValidateSignWithKey(bad)
		if err == nil {
			t.Fatalf("accepted key material: %q", bad[:8])
		}
		if !errors.Is(err, exitcode.ErrConfiguration) {
			t.Fatalf("err = %v, want a configuration error", err)
		}
		// The whole point: the value must not come back out in the message,
		// which is headed for a terminal, a CI log, and a pasted bug report.
		if strings.Contains(err.Error(), bad) {
			t.Fatal("echoed the secret back in the error")
		}
	}
}

func TestValidateSignWithKey_RefusesEmpty(t *testing.T) {
	if err := ValidateSignWithKey("   "); !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("err = %v", err)
	}
}
