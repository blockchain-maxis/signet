package link

import (
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

func TestValidateHandle(t *testing.T) {
	for _, ok := range []string{"alice", "a", "dev-1_x", strings.Repeat("a", 32)} {
		if err := ValidateHandle(ok); err != nil {
			t.Fatalf("ValidateHandle(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{"", "Alice", "has space", strings.Repeat("a", 33), "emoji😀"} {
		if err := ValidateHandle(bad); err == nil {
			t.Fatalf("ValidateHandle(%q) accepted it", bad)
		}
	}
}

func TestValidateHandle_ExitCode(t *testing.T) {
	err := ValidateHandle("NOPE")
	var coder interface{ ExitCode() int }
	if !asExitCoder(err, &coder) {
		t.Fatalf("err does not carry an exit code: %v", err)
	}
	if coder.ExitCode() != exitcode.InvalidInput {
		t.Fatalf("exit code = %d, want InvalidInput", coder.ExitCode())
	}
}

func TestValidateHandle_RedactsASecretShapedValue(t *testing.T) {
	secret := "S" + strings.Repeat("A", 55)
	err := ValidateHandle(secret)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("error echoed a secret-shaped value back")
	}
	if !strings.Contains(err.Error(), "redacted") {
		t.Fatalf("error did not say it redacted anything: %v", err)
	}
}

func TestValidatePublicKey(t *testing.T) {
	valid := "G" + strings.Repeat("A", 55)
	if err := ValidatePublicKey(valid); err != nil {
		t.Fatalf("ValidatePublicKey(valid) = %v", err)
	}
	// Note "G"+55 more G's is *valid* — G is inside the A-Z2-7 StrKey
	// alphabet — so the too-long case has to actually be too long.
	for _, bad := range []string{
		"",
		"GABC",
		"S" + strings.Repeat("A", 55),
		"G" + strings.Repeat("A", 56),
		"G" + strings.Repeat("1", 55), // 1 is not in the base32 alphabet
	} {
		if err := ValidatePublicKey(bad); err == nil {
			t.Fatalf("ValidatePublicKey(%q) accepted it", bad)
		}
	}
}

func TestValidatePublicKey_NeverEchoesTheValue(t *testing.T) {
	// The value could be a secret key put in the wrong flag; the message must
	// not carry it either way.
	secret := "S" + strings.Repeat("B", 55)
	err := ValidatePublicKey(secret)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error echoed the value: %v", err)
	}
}

func asExitCoder(err error, target *interface{ ExitCode() int }) bool {
	c, ok := err.(interface{ ExitCode() int })
	if ok {
		*target = c
	}
	return ok
}
