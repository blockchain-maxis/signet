package fork

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// EntrySource is the part of *rpc.Client a fetch needs.
type EntrySource interface {
	GetLedgerEntries(ctx context.Context, keys []string) (rpc.LedgerEntries, error)
}

// Fetcher answers the simulator's ledger_fetch for one fork: from the cache
// when it can, else from RPC, storing whatever RPC said (including that a
// key does not exist) so the next run starts warm.
//
// RPC only serves the latest state, so an entry fetched after the fork
// ledger may have changed since (#551). Such an entry is drifted: marked so
// in the cache, and counted in Drift for every run that reads it.
type Fetcher struct {
	Ctx   context.Context
	Cache *Cache
	RPC   EntrySource
	// ForkLedger is the ledger the fork is pinned at; 0 disables drift
	// tracking.
	ForkLedger uint32

	mu      sync.Mutex
	drifted map[string]uint32 // key -> lastModifiedLedgerSeq
}

// Drift is what a run read that changed on-chain after the fork ledger.
type Drift struct {
	ForkLedger uint32 `json:"forkLedger"`
	// NewestLedger is the latest lastModifiedLedgerSeq among the drifted
	// entries: the run mixed ForkLedger with ledgers up to this one.
	NewestLedger uint32   `json:"newestLedger"`
	Keys         []string `json:"keys"`
}

// Count is how many entries drifted.
func (d Drift) Count() int { return len(d.Keys) }

// Warning is the one line a person sees about it.
func (d Drift) Warning() string {
	noun := "entries"
	if d.Count() == 1 {
		noun = "entry"
	}
	return fmt.Sprintf("⚠ %d %s changed on-chain after the fork ledger; results mix ledger %d and %d", d.Count(), noun, d.ForkLedger, d.NewestLedger)
}

// Drift reports what this Fetcher's runs read that drifted.
func (f *Fetcher) Drift() Drift {
	f.mu.Lock()
	defer f.mu.Unlock()
	d := Drift{ForkLedger: f.ForkLedger, Keys: []string{}}
	for k, seq := range f.drifted {
		d.Keys = append(d.Keys, k)
		d.NewestLedger = max(d.NewestLedger, seq)
	}
	sort.Strings(d.Keys)
	return d
}

func (f *Fetcher) noteDrift(key string, seq uint32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.drifted == nil {
		f.drifted = map[string]uint32{}
	}
	f.drifted[key] = seq
}

// Fetch is a simulator.FetchFunc.
func (f *Fetcher) Fetch(keys []string) ([]simulator.Entry, error) {
	found, absent, err := f.Cache.Lookup(keys)
	if err != nil {
		return nil, err
	}
	var missing []string
	for _, k := range keys {
		if _, ok := found[k]; !ok && !absent[k] {
			missing = append(missing, k)
		}
	}

	if len(missing) > 0 {
		got, err := f.RPC.GetLedgerEntries(f.Ctx, missing)
		if err != nil {
			return nil, err
		}
		fetched := make([]Entry, 0, len(got.Entries))
		seen := map[string]bool{}
		for _, e := range got.Entries {
			entry := Entry{
				Key:                   e.Key,
				XDR:                   e.XDR,
				ExtXDR:                e.ExtXDR,
				LastModifiedLedgerSeq: e.LastModifiedLedgerSeq,
				LiveUntilLedgerSeq:    e.LiveUntilLedgerSeq,
				FetchedAtLedger:       got.LatestLedger,
				Drifted:               f.ForkLedger != 0 && e.LastModifiedLedgerSeq > f.ForkLedger,
			}
			fetched = append(fetched, entry)
			found[e.Key] = entry
			seen[e.Key] = true
		}
		if err := f.Cache.PutEntries(fetched); err != nil {
			return nil, err
		}
		var gone []string
		for _, k := range missing {
			if !seen[k] {
				gone = append(gone, k)
				absent[k] = true
			}
		}
		if len(gone) > 0 {
			if err := f.Cache.PutAbsent(gone, got.LatestLedger); err != nil {
				return nil, err
			}
		}
	}

	out := make([]simulator.Entry, 0, len(keys))
	for _, k := range keys {
		e, ok := found[k]
		if !ok {
			out = append(out, simulator.Absent(k))
			continue
		}
		if e.Drifted {
			f.noteDrift(k, e.LastModifiedLedgerSeq)
		}
		seq := e.LastModifiedLedgerSeq
		out = append(out, simulator.Entry{
			KeyXDR:                k,
			DataXDR:               e.XDR,
			LastModifiedLedgerSeq: &seq,
			ExtXDR:                e.ExtXDR,
			LiveUntilLedger:       e.LiveUntilLedgerSeq,
		})
	}
	return out, nil
}
