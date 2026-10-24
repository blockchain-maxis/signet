package fork

import (
	"errors"
	"os"
	"path/filepath"
	"sort"

	bolt "go.etcd.io/bbolt"
	bolterrors "go.etcd.io/bbolt/errors"
)

// Info describes one fork on disk, for `signet sandbox forks ls`.
type Info struct {
	Manifest
	ID  string `json:"id"`
	Dir string `json:"dir"`
	// Entries counts the cached ledger entries; -1 when another process
	// holds the fork and it could not be read.
	Entries   int   `json:"entries"`
	SizeBytes int64 `json:"sizeBytes"`
	InUse     bool  `json:"inUse,omitempty"`
}

// List returns every fork under root, oldest fork ledger first within each
// network. A directory without a readable manifest is skipped: it is not a
// fork this version of signet wrote.
func List(root string) ([]Info, error) {
	networks, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return []Info{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Info{}
	for _, network := range networks {
		if !network.IsDir() {
			continue
		}
		forks, err := os.ReadDir(filepath.Join(root, network.Name()))
		if err != nil {
			continue
		}
		for _, f := range forks {
			dir := filepath.Join(root, network.Name(), f.Name())
			m, err := ReadManifest(dir)
			if err != nil {
				continue
			}
			info := Info{Manifest: m, ID: f.Name(), Dir: dir, SizeBytes: dirSize(dir)}
			info.Entries, info.InUse = countEntries(dir)
			out = append(out, info)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Network != out[j].Network {
			return out[i].Network < out[j].Network
		}
		if out[i].Contract != out[j].Contract {
			return out[i].Contract < out[j].Contract
		}
		return out[i].ForkLedger < out[j].ForkLedger
	})
	return out, nil
}

// Remove deletes a fork's directory. A fork another process holds is
// refused, rather than pulled out from under it.
func Remove(info Info) error {
	if info.InUse {
		return &InUseError{Path: info.Dir, PID: readOwner(info.Dir)}
	}
	return os.RemoveAll(info.Dir)
}

func dirSize(dir string) int64 {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total
}

// countEntries opens the database read-only for a moment. A writer holding
// it makes the fork "in use".
func countEntries(dir string) (int, bool) {
	db, err := bolt.Open(filepath.Join(dir, dbFile), 0o600, &bolt.Options{ReadOnly: true, Timeout: lockWait})
	if err != nil {
		return -1, errors.Is(err, bolterrors.ErrTimeout)
	}
	defer func() { _ = db.Close() }()
	n := 0
	_ = db.View(func(tx *bolt.Tx) error {
		if b := tx.Bucket(bucketEntries); b != nil {
			n = b.Stats().KeyN
		}
		return nil
	})
	return n, false
}
