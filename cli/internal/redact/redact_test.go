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

func TestSecrets_RedactsApiKeys(t *testing.T) {
	key := "sgk_Ab12Cd34_" + strings.Repeat("x", 43)
	got := Secrets("failed to authenticate with " + key)
	if strings.Contains(got, key) || strings.Contains(got, "sgk_") {
		t.Fatalf("API key survived: %q", got)
	}
	if got != "failed to authenticate with "+Placeholder {
		t.Fatalf("got %q", got)
	}
}

func TestSecrets_RedactsAuthorizationValuesAndKeepsTheName(t *testing.T) {
	got := Secrets("request failed: Authorization: Bearer sgk_Ab12Cd34_secretvalue")
	if strings.Contains(got, "secretvalue") {
		t.Fatalf("authorization value survived: %q", got)
	}
	if !strings.Contains(got, "Authorization:") {
		t.Fatalf("authorization header name was removed: %q", got)
	}
	if !strings.Contains(got, AuthorizationPlaceholder) {
		t.Fatalf("no authorization placeholder in %q", got)
	}
}
