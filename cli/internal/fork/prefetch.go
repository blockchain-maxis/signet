package fork

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

// Prefetch memory (#552): the keys each call of a contract had to fetch, by
// function, so the next run of the same call asks for them all in one
// batch before it starts instead of one round trip at a time. It is kept
// per network beside the forks, not in one, so a new fork of the same
// contract (after drift, or forks rm) starts warm.

func prefetchPath(root, passphrase, contract string) string {
	return filepath.Join(root, NetworkKey(passphrase), "prefetch", contract+".json")
}

// PrefetchKeys are the keys earlier runs of contract's function fetched,
// sorted; none when nothing is remembered.
func PrefetchKeys(root, passphrase, contract, function string) ([]string, error) {
	byFunction, err := readPrefetch(root, passphrase, contract)
	if err != nil {
		return nil, err
	}
	return byFunction[function], nil
}

// RememberMisses adds a run's fetched keys to what function is known to
// need.
func RememberMisses(root, passphrase, contract, function string, misses []string) error {
	if len(misses) == 0 {
		return nil
	}
	byFunction, err := readPrefetch(root, passphrase, contract)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	var keys []string
	for _, k := range append(byFunction[function], misses...) {
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	byFunction[function] = keys
	raw, err := json.MarshalIndent(byFunction, "", "  ")
	if err != nil {
		return err
	}
	path := prefetchPath(root, passphrase, contract)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readPrefetch(root, passphrase, contract string) (map[string][]string, error) {
	raw, err := os.ReadFile(prefetchPath(root, passphrase, contract))
	if errors.Is(err, os.ErrNotExist) {
		return map[string][]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var byFunction map[string][]string
	if err := json.Unmarshal(raw, &byFunction); err != nil {
		// A damaged memory only costs a slower run: start afresh.
		return map[string][]string{}, nil
	}
	return byFunction, nil
}
