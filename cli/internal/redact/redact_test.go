package redact

import (
	"strings"
	"testing"
)

func TestSecrets_RedactsASecretSeedAndKeepsTheRest(t *testing.T) {
	seed := "SASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"
	got := Secrets("error: bad key " + seed + " in config")
	if strings.Contains(got, seed) {
		t.Fatalf("seed survived: %q", got)
	}
	if got != "error: bad key "+Placeholder+" in config" {
		t.Fatalf("got %q", got)
	}
}

func TestSecrets_LeavesPublicKeysAlone(t *testing.T) {
	pub := "GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"
	if got := Secrets(pub); got != pub {
		t.Fatalf("redacted a public key: %q", got)
	}
}
