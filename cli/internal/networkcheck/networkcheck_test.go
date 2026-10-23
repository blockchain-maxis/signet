package networkcheck

import (
	"errors"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const (
	testnetPassphrase = "Test SDF Network ; September 2015"
	mainnetPassphrase = "Public Global Stellar Network ; September 2015"
)

func deployment(passphrase string) api.Discovery {
	return api.Discovery{URL: "https://signet.example", NetworkPassphrase: passphrase}
}

func TestCompare_MatchingNetworksPass(t *testing.T) {
	for requested, passphrase := range map[string]string{
		"testnet":   testnetPassphrase,
		"mainnet":   mainnetPassphrase,
		"public":    mainnetPassphrase, // aliases, as the server accepts them
		" PubNet ":  mainnetPassphrase,
		"futurenet": "Test SDF Future Network ; October 2022",
		"local":     "Standalone Network ; February 2017",
	} {
		if err := Compare(requested, deployment(passphrase)); err != nil {
			t.Errorf("Compare(%q, %q) = %v, want nil", requested, passphrase, err)
		}
	}
}

func TestCompare_MismatchIsExit3AndNamesBothNetworksAndTheFix(t *testing.T) {
	err := Compare("mainnet", deployment(testnetPassphrase))
	if err == nil {
		t.Fatal("mainnet against a testnet deployment passed")
	}
	if !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("mismatch does not wrap ErrConfiguration: %v", err)
	}
	if code, ok := exitcode.CodeFor(err); !ok || code != exitcode.Configuration {
		t.Fatalf("exit code = %d (%v), want %d", code, ok, exitcode.Configuration)
	}
	want := `configuration error: signet is set to network mainnet, but https://signet.example serves testnet ("Test SDF Network ; September 2015"); use --network testnet, or signet context use <name> for a context on testnet`
	if err.Error() != want {
		t.Fatalf("message:\n got %s\nwant %s", err, want)
	}
}

func TestCompare_AnAliasIsReportedByItsCanonicalName(t *testing.T) {
	err := Compare("public", deployment(testnetPassphrase))
	if err == nil || !strings.Contains(err.Error(), "set to network mainnet") {
		t.Fatalf("got %v", err)
	}
}

func TestCompare_AnUnknownRequestedNetworkCannotMatch(t *testing.T) {
	err := Compare("devnet", deployment(testnetPassphrase))
	if !errors.Is(err, exitcode.ErrConfiguration) || !strings.Contains(err.Error(), "set to network devnet") {
		t.Fatalf("got %v", err)
	}
}

func TestCompare_ACustomDeploymentNetworkIsNamedByItsPassphrase(t *testing.T) {
	err := Compare("testnet", deployment("My Private Network ; 2026"))
	if err == nil {
		t.Fatal("testnet against a private network passed")
	}
	msg := err.Error()
	if !strings.Contains(msg, `serves "My Private Network ; 2026"`) || !strings.Contains(msg, "point signet at a deployment for testnet") {
		t.Fatalf("message: %s", msg)
	}
}

func TestCompare_NoPublishedPassphraseIsNothingToCompare(t *testing.T) {
	if err := Compare("mainnet", deployment("")); err != nil {
		t.Fatalf("got %v, want nil", err)
	}
}

func TestNormalizeAndNameFor(t *testing.T) {
	if n, ok := Normalize("Mainnet"); !ok || n != "mainnet" {
		t.Errorf("Normalize(Mainnet) = %q, %v", n, ok)
	}
	if _, ok := Normalize("devnet"); ok {
		t.Error("devnet is not a known network")
	}
	if n, ok := NameFor(testnetPassphrase); !ok || n != "testnet" {
		t.Errorf("NameFor(testnet passphrase) = %q, %v", n, ok)
	}
}
