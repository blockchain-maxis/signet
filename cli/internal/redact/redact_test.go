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

func TestSecrets_RedactsApiKeysAndKeepsTheRest(t *testing.T) {
	key := "sgk_a1b2c3d4_abcdefghijklmnopqrstuvwxyz0123456789-_ABC"
	got := Secrets("Authorization: Bearer " + key)
	if strings.Contains(got, key) {
		t.Fatalf("api key survived: %q", got)
	}
	if got != "Authorization: Bearer "+Placeholder {
		t.Fatalf("got %q", got)
	}
}
