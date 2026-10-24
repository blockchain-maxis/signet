package fork

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const (
	registry   = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN"
	testnet    = "Test SDF Network ; September 2015"
	mainnet    = "Public Global Stellar Network ; September 2015"
	forkLedger = 4852095
)

func manifest(passphrase string) Manifest {
	return Manifest{
		Network: "testnet", Passphrase: passphrase, RPCURL: "https://soroban-testnet.stellar.org",
		Contract: registry, ForkLedger: forkLedger, ForkTime: time.Unix(1790000000, 0).UTC(), Protocol: 23,
	}
}

func create(t *testing.T, root string, m Manifest) *Cache {
	t.Helper()
	c, err := Create(root, m)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func u32(v uint32) *uint32 { return &v }

func TestEntriesRoundTrip(t *testing.T) {
	root := t.TempDir()
	c := create(t, root, manifest(testnet))

	in := []Entry{
		{Key: "AAAA", XDR: "BBBB", LastModifiedLedgerSeq: 10, LiveUntilLedgerSeq: u32(99), FetchedAtLedger: forkLedger},
		{Key: "CCCC", XDR: "DDDD", LastModifiedLedgerSeq: forkLedger + 3, FetchedAtLedger: forkLedger + 5, Drifted: true},
	}
	if err := c.PutEntries(in); err != nil {
		t.Fatal(err)
	}
	if err := c.PutAbsent([]string{"EEEE"}, forkLedger); err != nil {
		t.Fatal(err)
	}
	if err := c.PutWasm("ab12", []byte{0, 'a', 's', 'm'}); err != nil {
		t.Fatal(err)
	}
	if err := c.PutTx("ce05", []byte(`{"status":"SUCCESS"}`)); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}

	// A second process (here: a second open) sees all of it.
	c2, err := Open(root, testnet, ID(registry, forkLedger))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = c2.Close() }()

	found, absent, err := c2.Lookup([]string{"AAAA", "CCCC", "EEEE", "FFFF"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 || *found["AAAA"].LiveUntilLedgerSeq != 99 || !found["CCCC"].Drifted {
		t.Fatalf("found = %+v", found)
	}
	if !absent["EEEE"] || absent["FFFF"] {
		t.Fatalf("absent = %v; FFFF was never fetched and must not count as absent", absent)
	}
	if w, _ := c2.Wasm("ab12"); string(w) != "\x00asm" {
		t.Fatalf("wasm = %q", w)
	}
	if tx, _ := c2.Tx("ce05"); string(tx) != `{"status":"SUCCESS"}` {
		t.Fatalf("tx = %q", tx)
	}
	if m := c2.Manifest(); m.Contract != registry || m.ForkLedger != forkLedger || m.Protocol != 23 || m.Contracts == nil {
		t.Fatalf("manifest = %+v", m)
	}

	// Fetching an absent key later clears it from the absent set.
	if err := c2.PutEntries([]Entry{{Key: "EEEE", XDR: "FFFF"}}); err != nil {
		t.Fatal(err)
	}
	if _, absent, _ := c2.Lookup([]string{"EEEE"}); absent["EEEE"] {
		t.Fatal("a key stored as an entry is still marked absent")
	}
}

func TestTwoNetworksNeverShareAFork(t *testing.T) {
	root := t.TempDir()
	tn := create(t, root, manifest(testnet))
	mm := manifest(mainnet)
	mm.Network = "mainnet"
	mn := create(t, root, mm)

	if tn.Dir() == mn.Dir() {
		t.Fatalf("same contract and ledger on two networks share %s", tn.Dir())
	}
	if err := tn.PutEntries([]Entry{{Key: "AAAA", XDR: "testnet-value"}}); err != nil {
		t.Fatal(err)
	}
	found, _, err := mn.Lookup([]string{"AAAA"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 0 {
		t.Fatalf("mainnet fork sees a testnet entry: %+v", found)
	}
	want := filepath.Join(root, NetworkKey(testnet), registry+"@4852095")
	if tn.Dir() != want {
		t.Fatalf("dir = %s, want %s", tn.Dir(), want)
	}
	if len(NetworkKey(testnet)) != 16 {
		t.Fatalf("network key %q is not 16 hex digits", NetworkKey(testnet))
	}
}

func TestASecondOpenReportsTheOwningPID(t *testing.T) {
	root := t.TempDir()
	create(t, root, manifest(testnet))

	_, err := Open(root, testnet, ID(registry, forkLedger))
	var inUse *InUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("err = %v, want InUseError", err)
	}
	want := fmt.Sprintf("fork in use by PID %d", os.Getpid())
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("message %q should contain %q", err, want)
	}
	if !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatal("should wrap ErrConfiguration")
	}
}

func TestACorruptedDatabaseIsReported(t *testing.T) {
	root := t.TempDir()
	c := create(t, root, manifest(testnet))
	dir := c.Dir()
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	db := filepath.Join(dir, dbFile)
	if err := os.WriteFile(db, []byte(strings.Repeat("not a bolt database ", 400)), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := Open(root, testnet, ID(registry, forkLedger))
	var corrupt *CorruptError
	if !errors.As(err, &corrupt) {
		t.Fatalf("err = %v, want CorruptError", err)
	}
	for _, want := range []string{db, "signet sandbox forks rm " + ID(registry, forkLedger)} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message should mention %q: %s", want, err)
		}
	}
}

func TestOpenAMissingFork(t *testing.T) {
	_, err := Open(t.TempDir(), testnet, ID(registry, 1))
	if err == nil || !strings.Contains(err.Error(), "no fork at") || !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("err = %v", err)
	}
}

func TestParseID(t *testing.T) {
	c, l, err := ParseID(ID(registry, forkLedger))
	if err != nil || c != registry || l != forkLedger {
		t.Fatalf("ParseID = %s, %d, %v", c, l, err)
	}
	for _, bad := range []string{"", "C", "C@", "@5", "C@x"} {
		if _, _, err := ParseID(bad); err == nil {
			t.Errorf("ParseID(%q) should fail", bad)
		}
	}
}
