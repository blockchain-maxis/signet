// Package realtx finds a contract's recent real transactions and turns them
// into replays (#635, #636).
//
// A saved suite covers what the developer thought of; the contract's real
// traffic covers what its users do. RPC cannot search transactions by
// footprint, so three imperfect sources are combined, and every transaction
// says which found it:
//
//   - events: getEvents for the contract over the RPC's retention window,
//     then getTransaction for each one. Finds only transactions in which
//     the contract emitted an event.
//   - scan (opt-in, bounded): getTransactions over the last N ledgers,
//     keeping those whose host function calls the contract. Slow.
//   - indexer: transaction hashes a Signet deployment indexed for the
//     contract, fetched from RPC while still inside retention.
//
// The newest successful invocations are kept, deduplicated, and cached in
// the fork's txs bucket. A transaction found but no longer retrievable is
// reported as such, never dropped silently.
package realtx

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/rpc"
)

// Source is how a transaction was found.
type Source string

const (
	SourceEvents  Source = "events"
	SourceScan    Source = "scan"
	SourceIndexer Source = "indexer"
)

// RPC is the slice of the Stellar RPC client collection uses.
type RPC interface {
	GetHealth(ctx context.Context) (rpc.Health, error)
	GetEvents(ctx context.Context, req rpc.EventsRequest) (rpc.Events, error)
	GetTransactions(ctx context.Context, startLedger uint32, cursor string, limit int) (rpc.Transactions, error)
	GetTransaction(ctx context.Context, hash string) (rpc.Transaction, error)
}

// Decoded is the part of tx_decode's answer (#532) a replay needs.
type Decoded struct {
	SourceAccount string `json:"source_account"`
	HostFunction  struct {
		Kind       *string `json:"kind"`
		Replayable bool    `json:"replayable"`
		Reason     string  `json:"reason,omitempty"`
		ContractID string  `json:"contract_id,omitempty"`
		Function   string  `json:"function,omitempty"`
		Args       []struct {
			XDR string `json:"xdr"`
		} `json:"args,omitempty"`
	} `json:"host_function"`
	Result *OnChain `json:"result,omitempty"`
}

// OnChain is what the transaction did on-chain, from its meta.
type OnChain struct {
	ReturnValue *XDRValue      `json:"return_value"`
	Events      []OnChainEvent `json:"events"`
}

// XDRValue is a decoded value with its XDR.
type XDRValue struct {
	XDR string `json:"xdr"`
}

// OnChainEvent is one event in the meta.
type OnChainEvent struct {
	Type       string  `json:"type"`
	ContractID *string `json:"contract_id"`
	EventXDR   string  `json:"event_xdr"`
}

// Decoder runs tx_decode on an envelope and its meta.
type Decoder func(ctx context.Context, envelopeXDR, resultMetaXDR string) (Decoded, error)

// Cache is where fetched transactions are kept: the fork's txs bucket.
type Cache interface {
	PutTx(hash string, raw []byte) error
	Tx(hash string) ([]byte, error)
}

// Options says what to collect.
type Options struct {
	Contract string
	// Limit keeps the newest Limit successful invocations (recent_transactions).
	Limit int
	// ScanLedgers turns on the ledger scan over the last N ledgers; 0 is off.
	ScanLedgers uint32
	// Indexed returns transaction hashes a Signet deployment indexed for the
	// contract; nil is off.
	Indexed func(ctx context.Context) ([]string, error)
	Decode  Decoder
	// Cache, when set, is read before and written after each getTransaction.
	Cache Cache
	// IncludeFailed keeps transactions that failed on-chain, whose replay
	// is checked to fail too.
	IncludeFailed bool
}

// Tx is one real transaction to replay.
type Tx struct {
	Hash    string
	Ledger  uint32
	Sources []Source
	Decoded Decoded
	// Failed is set on a transaction that failed on-chain.
	Failed bool
}

// Function is the contract function the transaction called.
func (t Tx) Function() string { return t.Decoded.HostFunction.Function }

// ArgsXDR are its arguments, exactly as it sent them.
func (t Tx) ArgsXDR() []string {
	out := make([]string, len(t.Decoded.HostFunction.Args))
	for i, a := range t.Decoded.HostFunction.Args {
		out[i] = a.XDR
	}
	return out
}

// Left is a transaction found but not replayed, and why.
type Left struct {
	Hash    string   `json:"hash"`
	Ledger  uint32   `json:"ledger,omitempty"`
	Sources []Source `json:"sources"`
	Reason  string   `json:"reason"`
}

// Report is what collection found.
type Report struct {
	// Transactions are the newest successful invocations, newest first.
	Transactions []Tx
	// NotRetrievable were found (by the indexer, mostly) but are gone from
	// the RPC: outside its retention window.
	NotRetrievable []Left
	// Skipped are retrievable but not replayed: failed on-chain, not an
	// InvokeContract, or calling the contract through another.
	Skipped []Left
	// PerSource counts the transactions each source found.
	PerSource map[Source]int
	// From and To are the ledgers the RPC still had: the window covered.
	From, To uint32
}

// Summary is the report in one line: counts per source and the window.
func (r Report) Summary() string {
	var parts []string
	for _, s := range []Source{SourceEvents, SourceScan, SourceIndexer} {
		if n, ok := r.PerSource[s]; ok {
			parts = append(parts, fmt.Sprintf("%d by %s", n, s))
		}
	}
	line := fmt.Sprintf("%d real transaction%s to replay (ledgers %d–%d)", len(r.Transactions), plural(len(r.Transactions)), r.From, r.To)
	if len(parts) > 0 {
		line += ": found " + strings.Join(parts, ", ")
	}
	if n := len(r.NotRetrievable); n > 0 {
		line += fmt.Sprintf("; %d no longer retrievable", n)
	}
	if n := len(r.Skipped); n > 0 {
		line += fmt.Sprintf("; %d skipped", n)
	}
	return line
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

const (
	eventPages = 50
	pageSize   = 200
)

type candidate struct {
	ledger  uint32
	sources []Source
	tx      *rpc.Transaction
	decoded *Decoded
}

// Collect finds the contract's recent real transactions.
func Collect(ctx context.Context, client RPC, opts Options) (Report, error) {
	health, err := client.GetHealth(ctx)
	if err != nil {
		return Report{}, err
	}
	report := Report{PerSource: map[Source]int{}, To: health.LatestLedger, From: health.OldestLedger}
	if health.LedgerRetentionWindow > 0 && health.LatestLedger >= health.LedgerRetentionWindow {
		report.From = max(report.From, health.LatestLedger-health.LedgerRetentionWindow+1)
	}

	found := map[string]*candidate{}
	add := func(hash string, ledger uint32, source Source) *candidate {
		c, ok := found[hash]
		if !ok {
			c = &candidate{ledger: ledger}
			found[hash] = c
		}
		if ledger > 0 {
			c.ledger = ledger
		}
		if !slices.Contains(c.sources, source) {
			c.sources = append(c.sources, source)
			report.PerSource[source]++
		}
		return c
	}

	// Source 1: the contract's events.
	report.PerSource[SourceEvents] = 0
	cursor := ""
	for page := 0; page < eventPages; page++ {
		req := rpc.EventsRequest{Filters: []rpc.EventFilter{{Type: "contract", ContractIDs: []string{opts.Contract}}}, Limit: pageSize}
		if cursor == "" {
			req.StartLedger = report.From
		} else {
			req.Cursor = cursor
		}
		events, err := client.GetEvents(ctx, req)
		if oldest, ok := outOfRange(err); ok && cursor == "" && oldest > report.From {
			// The window moved between getHealth and getEvents: start
			// where the RPC says it now starts.
			report.From, req.StartLedger = oldest, oldest
			events, err = client.GetEvents(ctx, req)
		}
		if err != nil {
			return Report{}, fmt.Errorf("getEvents: %w", err)
		}
		for _, e := range events.Events {
			add(e.TxHash, e.Ledger, SourceEvents)
		}
		if len(events.Events) < pageSize || events.Cursor == "" || events.Cursor == cursor {
			break
		}
		cursor = events.Cursor
	}

	// Source 2: a bounded scan of the newest ledgers, for transactions that
	// emitted nothing.
	if opts.ScanLedgers > 0 {
		report.PerSource[SourceScan] = 0
		start := report.From
		if report.To >= opts.ScanLedgers && report.To-opts.ScanLedgers+1 > start {
			start = report.To - opts.ScanLedgers + 1
		}
		cursor := ""
		for {
			page, err := client.GetTransactions(ctx, start, cursor, pageSize)
			if err != nil {
				return Report{}, fmt.Errorf("getTransactions: %w", err)
			}
			for i := range page.Transactions {
				t := page.Transactions[i]
				replayable := t.Status == "SUCCESS" || t.Status == "FAILED" && opts.IncludeFailed
				if t.Ledger > report.To || !replayable || t.EnvelopeXDR == "" {
					continue
				}
				decoded, err := opts.Decode(ctx, t.EnvelopeXDR, t.ResultMetaXDR)
				if err != nil || decoded.HostFunction.ContractID != opts.Contract {
					continue
				}
				c := add(t.TxHash, t.Ledger, SourceScan)
				c.tx, c.decoded = &t, &decoded
			}
			if len(page.Transactions) < pageSize || page.Cursor == "" || page.Cursor == cursor {
				break
			}
			cursor = page.Cursor
		}
	}

	// Source 3: what a Signet deployment indexed.
	if opts.Indexed != nil {
		report.PerSource[SourceIndexer] = 0
		hashes, err := opts.Indexed(ctx)
		if err != nil {
			return Report{}, fmt.Errorf("the Signet indexer: %w", err)
		}
		for _, h := range hashes {
			add(h, 0, SourceIndexer)
		}
	}

	hashes := make([]string, 0, len(found))
	for h := range found {
		hashes = append(hashes, h)
	}
	slices.Sort(hashes)
	for _, hash := range hashes {
		c := found[hash]
		left := Left{Hash: hash, Ledger: c.ledger, Sources: c.sources}
		if c.tx == nil {
			t, err := fetch(ctx, client, opts.Cache, hash)
			if err != nil {
				return Report{}, fmt.Errorf("getTransaction %s: %w", short(hash), err)
			}
			c.tx = &t
			if t.Ledger > 0 {
				c.ledger, left.Ledger = t.Ledger, t.Ledger
			}
		} else if opts.Cache != nil {
			if raw, err := json.Marshal(c.tx); err == nil {
				_ = opts.Cache.PutTx(hash, raw)
			}
		}
		switch c.tx.Status {
		case "SUCCESS":
		case "NOT_FOUND":
			left.Reason = fmt.Sprintf("not retrievable: outside the RPC's retention window (ledgers %d–%d)", report.From, report.To)
			report.NotRetrievable = append(report.NotRetrievable, left)
			continue
		case "FAILED":
			if opts.IncludeFailed {
				break
			}
			left.Reason = "failed on-chain (include_failed replays it)"
			report.Skipped = append(report.Skipped, left)
			continue
		default:
			left.Reason = "failed on-chain (" + strings.ToLower(c.tx.Status) + ")"
			report.Skipped = append(report.Skipped, left)
			continue
		}
		if c.decoded == nil {
			decoded, err := opts.Decode(ctx, c.tx.EnvelopeXDR, c.tx.ResultMetaXDR)
			if err != nil {
				left.Reason = "could not be decoded: " + err.Error()
				report.Skipped = append(report.Skipped, left)
				continue
			}
			c.decoded = &decoded
		}
		hf := c.decoded.HostFunction
		switch {
		case !hf.Replayable:
			left.Reason = "not replayable: " + hf.Reason
			report.Skipped = append(report.Skipped, left)
			continue
		case hf.ContractID != opts.Contract:
			left.Reason = fmt.Sprintf("called the contract through %s, not directly", short(hf.ContractID))
			report.Skipped = append(report.Skipped, left)
			continue
		}
		report.Transactions = append(report.Transactions, Tx{Hash: hash, Ledger: c.ledger, Sources: c.sources, Decoded: *c.decoded, Failed: c.tx.Status == "FAILED"})
	}
	slices.SortFunc(report.Transactions, func(a, b Tx) int {
		if a.Ledger != b.Ledger {
			return int(b.Ledger) - int(a.Ledger)
		}
		return strings.Compare(a.Hash, b.Hash)
	})
	if opts.Limit >= 0 && len(report.Transactions) > opts.Limit {
		report.Transactions = report.Transactions[:opts.Limit]
	}
	return report, nil
}

// rangeError is how an RPC refuses a startLedger outside its window:
// "startLedger must be within the ledger range: 5276464 - 5397423".
var rangeError = regexp.MustCompile(`ledger range: (\d+) - \d+`)

// outOfRange is the oldest ledger an RPC named when it refused a
// startLedger as out of its range.
func outOfRange(err error) (uint32, bool) {
	if err == nil {
		return 0, false
	}
	m := rangeError.FindStringSubmatch(err.Error())
	if m == nil {
		return 0, false
	}
	n, perr := strconv.ParseUint(m[1], 10, 32)
	return uint32(n), perr == nil
}

// fetch reads a transaction from the cache, or from RPC into the cache. A
// transaction RPC no longer has is not cached: it may be another RPC's;
// only a final status is.
func fetch(ctx context.Context, client RPC, cache Cache, hash string) (rpc.Transaction, error) {
	if cache != nil {
		if raw, err := cache.Tx(hash); err == nil && raw != nil {
			var t rpc.Transaction
			if json.Unmarshal(raw, &t) == nil && t.Status != "" {
				return t, nil
			}
		}
	}
	t, err := client.GetTransaction(ctx, hash)
	if err != nil {
		return rpc.Transaction{}, err
	}
	if cache != nil && (t.Status == "SUCCESS" || t.Status == "FAILED") {
		if raw, err := json.Marshal(t); err == nil {
			_ = cache.PutTx(hash, raw)
		}
	}
	return t, nil
}

func short(s string) string {
	if len(s) > 12 {
		return s[:4] + "…" + s[len(s)-4:]
	}
	return s
}
