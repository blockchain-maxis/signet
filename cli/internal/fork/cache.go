// Package fork keeps a sandbox fork on disk: the entries, executables and
// transactions fetched for one contract at one pinned ledger, so a second run
// starts from the cache instead of the network.
//
// A fork lives at <UserCacheDir>/signet/forks/<network>/<forkId>/, where
// <network> is the first 16 hex digits of sha256(passphrase) and forkId is
// <contract>@<forkLedger>. Entries from different networks, or from
// different fork ledgers, therefore never share a directory, let alone a
// database.
package fork

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
	bolterrors "go.etcd.io/bbolt/errors"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const (
	dbFile       = "fork.db"
	manifestFile = "manifest.json"
	ownerFile    = "owner.pid"
	// lockWait is how long Open waits for another process to let go.
	lockWait = 250 * time.Millisecond
)

var (
	bucketEntries = []byte("entries")
	bucketAbsent  = []byte("absent")
	bucketWasm    = []byte("wasm")
	bucketTxs     = []byte("txs")
	bucketMeta    = []byte("meta")
)

// Root is where every fork lives: os.UserCacheDir()/signet/forks.
func Root() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("%w: no user cache directory: %v", exitcode.ErrConfiguration, err)
	}
	return filepath.Join(dir, "signet", "forks"), nil
}

// NetworkKey is the directory name for a network: the first 16 hex digits of
// sha256(passphrase).
func NetworkKey(passphrase string) string {
	sum := sha256.Sum256([]byte(passphrase))
	return hex.EncodeToString(sum[:])[:16]
}

// ID names a fork: <contract>@<forkLedger>.
func ID(contract string, forkLedger uint32) string {
	return contract + "@" + strconv.FormatUint(uint64(forkLedger), 10)
}

// ParseID splits an ID back into contract and ledger.
func ParseID(id string) (contract string, ledger uint32, err error) {
	c, l, ok := strings.Cut(id, "@")
	n, perr := strconv.ParseUint(l, 10, 32)
	if !ok || c == "" || perr != nil {
		return "", 0, fmt.Errorf("%q is not a fork id (<contract>@<ledger>)", id)
	}
	return c, uint32(n), nil
}

// Dir is a fork's directory under root.
func Dir(root, passphrase, id string) string {
	return filepath.Join(root, NetworkKey(passphrase), id)
}

// Manifest describes a fork. It is written as manifest.json beside the
// database, so a person (or `signet sandbox forks ls`) can read it without
// opening the database.
type Manifest struct {
	Network    string    `json:"network"`
	Passphrase string    `json:"passphrase"`
	RPCURL     string    `json:"rpcUrl"`
	Contract   string    `json:"contract"`
	ForkLedger uint32    `json:"forkLedger"`
	ForkTime   time.Time `json:"forkTime"`
	Protocol   int       `json:"protocol"`
	// Contracts are the other contracts pulled into the fork (#552).
	Contracts []string `json:"contracts"`
	// Lanes are the host lanes (ledger protocols) runs on this fork used.
	Lanes     []int     `json:"lanes"`
	CreatedAt time.Time `json:"createdAt"`

	// Executable is wasm, stellar_asset or external_ref (CAP-85), and
	// WasmHash the executable the contract ran at the fork ledger.
	Executable string `json:"executable,omitempty"`
	WasmHash   string `json:"wasmHash,omitempty"`
	// InstanceStorageEntries counts the instance's own storage map.
	InstanceStorageEntries int `json:"instanceStorageEntries"`
}

// ID is the manifest's fork id.
func (m Manifest) ID() string { return ID(m.Contract, m.ForkLedger) }

// Entry is a ledger entry as the fork holds it.
type Entry struct {
	Key string `json:"key"`
	// XDR is the LedgerEntryData RPC returned, and ExtXDR its extXdr.
	XDR                   string  `json:"xdr"`
	ExtXDR                string  `json:"extXdr,omitempty"`
	LastModifiedLedgerSeq uint32  `json:"lastModifiedLedgerSeq"`
	LiveUntilLedgerSeq    *uint32 `json:"liveUntilLedgerSeq,omitempty"`
	// FetchedAtLedger is the RPC's latest ledger when the entry was fetched.
	FetchedAtLedger uint32 `json:"fetchedAtLedger"`
	// Drifted is set when the entry changed on-chain after the fork ledger
	// (#551): the fork is then running on state that never existed at once.
	Drifted bool `json:"drifted,omitempty"`
}

// InUseError is a fork another process has open.
type InUseError struct {
	Path string
	PID  int // 0 when the owner did not leave its PID
}

func (e *InUseError) Error() string {
	if e.PID > 0 {
		return fmt.Sprintf("fork in use by PID %d (%s); wait for it to finish, or stop it", e.PID, e.Path)
	}
	return fmt.Sprintf("fork in use by another signet process (%s); wait for it to finish, or stop it", e.Path)
}

func (e *InUseError) Unwrap() error { return exitcode.ErrConfiguration }

// CorruptError is a fork database that cannot be read.
type CorruptError struct {
	Path string
	ID   string
	Err  error
}

func (e *CorruptError) Error() string {
	return fmt.Sprintf("the fork cache at %s is corrupted (%v); delete it with `signet sandbox forks rm %s` and fork again", e.Path, e.Err, e.ID)
}

func (e *CorruptError) Unwrap() []error { return []error{exitcode.ErrConfiguration, e.Err} }

// Cache is one open fork. Only one process may have a fork open at a time.
type Cache struct {
	dir      string
	db       *bolt.DB
	manifest Manifest
}

// Create opens the fork m describes under root, creating it if needed, and
// (re)writes its manifest.
func Create(root string, m Manifest) (*Cache, error) {
	if m.Contract == "" || m.Passphrase == "" || m.ForkLedger == 0 {
		return nil, errors.New("a fork needs a contract, a network passphrase and a fork ledger")
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now().UTC()
	}
	if m.Contracts == nil {
		m.Contracts = []string{}
	}
	if m.Lanes == nil {
		m.Lanes = []int{}
	}
	dir := Dir(root, m.Passphrase, m.ID())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("%w: create fork directory: %v", exitcode.ErrConfiguration, err)
	}
	c, err := open(dir, m.ID())
	if err != nil {
		return nil, err
	}
	c.manifest = m
	if err := c.SaveManifest(m); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

// Open opens an existing fork by network passphrase and id.
func Open(root, passphrase, id string) (*Cache, error) {
	dir := Dir(root, passphrase, id)
	m, err := ReadManifest(dir)
	if err != nil {
		return nil, err
	}
	c, err := open(dir, id)
	if err != nil {
		return nil, err
	}
	c.manifest = m
	return c, nil
}

// ReadManifest reads a fork directory's manifest.json.
func ReadManifest(dir string) (Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, manifestFile))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Manifest{}, fmt.Errorf("%w: no fork at %s", exitcode.ErrConfiguration, dir)
		}
		return Manifest{}, fmt.Errorf("%w: read fork manifest: %v", exitcode.ErrConfiguration, err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, &CorruptError{Path: filepath.Join(dir, manifestFile), ID: filepath.Base(dir), Err: err}
	}
	return m, nil
}

func open(dir, id string) (*Cache, error) {
	path := filepath.Join(dir, dbFile)
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: lockWait})
	if err != nil {
		if errors.Is(err, bolterrors.ErrTimeout) {
			return nil, &InUseError{Path: dir, PID: readOwner(dir)}
		}
		return nil, &CorruptError{Path: path, ID: id, Err: err}
	}
	// bbolt reads pages lazily, so a damaged file can open cleanly; walk it
	// once now rather than fail halfway through a run.
	err = db.View(func(tx *bolt.Tx) error {
		var first error
		// Drain every report so the checker's goroutine can finish.
		for err := range tx.Check() {
			if first == nil {
				first = err
			}
		}
		return first
	})
	if err == nil {
		err = db.Update(func(tx *bolt.Tx) error {
			for _, b := range [][]byte{bucketEntries, bucketAbsent, bucketWasm, bucketTxs, bucketMeta} {
				if _, err := tx.CreateBucketIfNotExists(b); err != nil {
					return err
				}
			}
			return nil
		})
	}
	if err != nil {
		_ = db.Close()
		return nil, &CorruptError{Path: path, ID: id, Err: err}
	}
	_ = os.WriteFile(filepath.Join(dir, ownerFile), []byte(strconv.Itoa(os.Getpid())), 0o600)
	return &Cache{dir: dir, db: db}, nil
}

func readOwner(dir string) int {
	raw, err := os.ReadFile(filepath.Join(dir, ownerFile))
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	return pid
}

// Close releases the fork for other processes.
func (c *Cache) Close() error {
	_ = os.Remove(filepath.Join(c.dir, ownerFile))
	return c.db.Close()
}

// Dir is the fork's directory.
func (c *Cache) Dir() string { return c.dir }

// Manifest is the fork's manifest as last saved.
func (c *Cache) Manifest() Manifest { return c.manifest }

// SaveManifest replaces manifest.json, atomically.
func (c *Cache) SaveManifest(m Manifest) error {
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(c.dir, manifestFile+".*")
	if err != nil {
		return fmt.Errorf("%w: write fork manifest: %v", exitcode.ErrConfiguration, err)
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("%w: write fork manifest: %v", exitcode.ErrConfiguration, err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(c.dir, manifestFile)); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("%w: write fork manifest: %v", exitcode.ErrConfiguration, err)
	}
	c.manifest = m
	return nil
}

// PutEntries stores entries, replacing any with the same key, and clears
// them from the absent set.
func (c *Cache) PutEntries(entries []Entry) error {
	return c.db.Update(func(tx *bolt.Tx) error {
		b, absent := tx.Bucket(bucketEntries), tx.Bucket(bucketAbsent)
		for _, e := range entries {
			raw, err := json.Marshal(e)
			if err != nil {
				return err
			}
			if err := b.Put([]byte(e.Key), raw); err != nil {
				return err
			}
			if err := absent.Delete([]byte(e.Key)); err != nil {
				return err
			}
		}
		return nil
	})
}

// PutAbsent records keys the network does not have, as of ledger.
func (c *Cache) PutAbsent(keys []string, ledger uint32) error {
	return c.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketAbsent)
		v := []byte(strconv.FormatUint(uint64(ledger), 10))
		for _, k := range keys {
			if err := b.Put([]byte(k), v); err != nil {
				return err
			}
		}
		return nil
	})
}

// Lookup returns the cached entries among keys and the keys known to be
// absent. A key in neither has never been fetched.
func (c *Cache) Lookup(keys []string) (found map[string]Entry, absent map[string]bool, err error) {
	found, absent = map[string]Entry{}, map[string]bool{}
	err = c.db.View(func(tx *bolt.Tx) error {
		b, ab := tx.Bucket(bucketEntries), tx.Bucket(bucketAbsent)
		for _, k := range keys {
			if raw := b.Get([]byte(k)); raw != nil {
				var e Entry
				if err := json.Unmarshal(raw, &e); err != nil {
					return fmt.Errorf("entry %s: %w", k, err)
				}
				found[k] = e
			} else if ab.Get([]byte(k)) != nil {
				absent[k] = true
			}
		}
		return nil
	})
	if err != nil {
		return nil, nil, &CorruptError{Path: filepath.Join(c.dir, dbFile), ID: c.manifest.ID(), Err: err}
	}
	return found, absent, nil
}

// Entries returns every cached entry, in key order.
func (c *Cache) Entries() ([]Entry, error) {
	var out []Entry
	err := c.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketEntries).ForEach(func(_, raw []byte) error {
			var e Entry
			if err := json.Unmarshal(raw, &e); err != nil {
				return err
			}
			out = append(out, e)
			return nil
		})
	})
	return out, err
}

// PutWasm stores an executable by its hex hash.
func (c *Cache) PutWasm(hash string, wasm []byte) error {
	return c.put(bucketWasm, hash, wasm)
}

// Wasm returns a stored executable, or nil.
func (c *Cache) Wasm(hash string) ([]byte, error) { return c.get(bucketWasm, hash) }

// PutTx stores a fetched transaction (getTransaction's JSON) by hash.
func (c *Cache) PutTx(hash string, raw []byte) error { return c.put(bucketTxs, hash, raw) }

// Tx returns a stored transaction, or nil.
func (c *Cache) Tx(hash string) ([]byte, error) { return c.get(bucketTxs, hash) }

// PutMeta stores a small value the fork's commands need to remember.
func (c *Cache) PutMeta(key string, v []byte) error { return c.put(bucketMeta, key, v) }

// Meta returns a stored meta value, or nil.
func (c *Cache) Meta(key string) ([]byte, error) { return c.get(bucketMeta, key) }

func (c *Cache) put(bucket []byte, key string, v []byte) error {
	return c.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucket).Put([]byte(key), v) })
}

func (c *Cache) get(bucket []byte, key string) ([]byte, error) {
	var out []byte
	err := c.db.View(func(tx *bolt.Tx) error {
		if v := tx.Bucket(bucket).Get([]byte(key)); v != nil {
			out = append([]byte(nil), v...)
		}
		return nil
	})
	return out, err
}
