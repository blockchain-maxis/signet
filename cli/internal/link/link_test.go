package link

import "testing"

const validPublicKey = "GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"

func TestLinkAcceptsAValidHandleAndPublicKey(t *testing.T) {
	got, err := Link("aquawolf", validPublicKey, "testnet")
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	want := Result{Handle: "aquawolf", PublicKey: validPublicKey, Network: "testnet", Status: "ok"}
	if got != want {
		t.Fatalf("Link() = %+v, want %+v", got, want)
	}
}

func TestLinkRejectsAnInvalidHandle(t *testing.T) {
	tooLong := ""
	for i := 0; i < 33; i++ {
		tooLong += "a"
	}
	for _, handle := range []string{"", "Not-Valid", "has space", tooLong} {
		if _, err := Link(handle, validPublicKey, "testnet"); err == nil {
			t.Fatalf("Link(%q, ...) succeeded, want an error", handle)
		}
	}
}

func TestLinkRejectsAnInvalidPublicKey(t *testing.T) {
	for _, pubkey := range []string{"", "not-a-key", "AASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"} {
		if _, err := Link("aquawolf", pubkey, "testnet"); err == nil {
			t.Fatalf("Link(..., %q, ...) succeeded, want an error", pubkey)
		}
	}
}
