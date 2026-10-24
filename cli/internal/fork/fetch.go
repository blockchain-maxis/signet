package fork

import (
	"context"

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
type Fetcher struct {
	Ctx   context.Context
	Cache *Cache
	RPC   EntrySource
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
