package cmd

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/realtx"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// recentTransactions is [replay] recent_transactions: off when the file
// does not set it (signet dev init writes 20).
func recentTransactions(f *devconfig.File) int {
	if f == nil || f.Replay.RecentTransactions == nil {
		return 0
	}
	return *f.Replay.RecentTransactions
}

// collectReal finds the contract's recent real transactions (#635) and
// keeps them as replays (#636) that every cycle runs after the saved calls.
// Not finding them is a warning: the saved calls still run.
func (s *devSession) collectReal(ctx context.Context, client *rpc.Client, network, contract string, f *devconfig.File, scan uint32, progress func(string)) {
	limit := recentTransactions(f)
	if limit == 0 {
		return
	}
	protocol := s.manifest.Protocol
	decode := func(ctx context.Context, envelope, meta string) (realtx.Decoded, error) {
		var out simulator.TxDecodeResult
		s.mu.Lock()
		_, err := callSimulator(ctx, s.sim, simulator.TypeTxDecode, simulator.TxDecodeParams{LedgerProtocol: &protocol, TransactionXDR: envelope, ResultMetaXDR: meta}, &out)
		s.mu.Unlock()
		var d realtx.Decoded
		if err == nil {
			err = json.Unmarshal(out.Transaction, &d)
		}
		return d, err
	}
	report, err := realtx.Collect(ctx, client, realtx.Options{
		Contract: contract, Limit: limit, ScanLedgers: scan, Decode: decode, Cache: s.cache,
		IncludeFailed: f.Replay.IncludeFailed,
	})
	if err != nil {
		progress("warning: no real transactions to replay: " + err.Error())
		return
	}
	progress(report.Summary())
	for _, l := range append(report.NotRetrievable, report.Skipped...) {
		progress(fmt.Sprintf("  %s: %s", shorten(l.Hash, 4, 4), l.Reason))
	}
	s.real = make([]dev.Replay, len(report.Transactions))
	for i, t := range report.Transactions {
		s.real[i] = dev.Replay{Name: t.Label(), Params: t.Params(), Real: &dev.RealTx{Tx: t, Link: realtx.Link(network, t.Hash)}}
	}
}

// replays are what a cycle runs: the saved calls, then the real
// transactions.
func (s *devSession) replays(f *devconfig.File) []dev.Replay {
	return append(devReplays(f), s.real...)
}
