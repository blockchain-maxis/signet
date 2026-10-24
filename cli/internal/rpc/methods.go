package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

// MaxLedgerEntryKeys is the most keys one getLedgerEntries call accepts:
// "The maximum number of ledger keys accepted is 200"
// (https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getLedgerEntries).
const MaxLedgerEntryKeys = 200

// ledgerEntryConcurrency bounds how many getLedgerEntries pages are in
// flight at once.
const ledgerEntryConcurrency = 4

// NetworkInfo answers getNetwork.
type NetworkInfo struct {
	FriendbotURL    string `json:"friendbotUrl,omitempty"`
	Passphrase      string `json:"passphrase"`
	ProtocolVersion int    `json:"protocolVersion"`
}

// GetNetwork reports which network the RPC serves.
func (c *Client) GetNetwork(ctx context.Context) (NetworkInfo, error) {
	var r NetworkInfo
	return r, c.call(ctx, "getNetwork", nil, &r)
}

// LatestLedger answers getLatestLedger.
type LatestLedger struct {
	ID              string `json:"id"`
	ProtocolVersion int    `json:"protocolVersion"`
	Sequence        uint32 `json:"sequence"`
}

// GetLatestLedger reports the newest ledger the RPC has ingested.
func (c *Client) GetLatestLedger(ctx context.Context) (LatestLedger, error) {
	var r LatestLedger
	return r, c.call(ctx, "getLatestLedger", nil, &r)
}

// VersionInfo answers getVersionInfo.
type VersionInfo struct {
	Version            string `json:"version"`
	CommitHash         string `json:"commitHash"`
	BuildTimestamp     string `json:"buildTimestamp"`
	CaptiveCoreVersion string `json:"captiveCoreVersion"`
	ProtocolVersion    int    `json:"protocolVersion"`
}

// GetVersionInfo reports the RPC build and the protocol it runs.
func (c *Client) GetVersionInfo(ctx context.Context) (VersionInfo, error) {
	var r VersionInfo
	return r, c.call(ctx, "getVersionInfo", nil, &r)
}

// Health answers getHealth. OldestLedger..LatestLedger is the retention
// window: transactions and events outside it are gone from this RPC.
type Health struct {
	Status                string `json:"status"`
	LatestLedger          uint32 `json:"latestLedger"`
	OldestLedger          uint32 `json:"oldestLedger"`
	LedgerRetentionWindow uint32 `json:"ledgerRetentionWindow"`
}

// GetHealth reports the RPC's status and retention window.
func (c *Client) GetHealth(ctx context.Context) (Health, error) {
	var r Health
	return r, c.call(ctx, "getHealth", nil, &r)
}

// LedgerEntry is one entry getLedgerEntries found. Keys it did not find are
// simply absent from the answer.
type LedgerEntry struct {
	Key                   string  `json:"key"`
	XDR                   string  `json:"xdr"`
	LastModifiedLedgerSeq uint32  `json:"lastModifiedLedgerSeq"`
	LiveUntilLedgerSeq    *uint32 `json:"liveUntilLedgerSeq,omitempty"`
	ExtXDR                string  `json:"extXdr,omitempty"`
}

// LedgerEntries answers GetLedgerEntries.
type LedgerEntries struct {
	Entries []LedgerEntry `json:"entries"`
	// LatestLedger is the newest latestLedger any page reported. Pages are
	// separate requests and may straddle a ledger close.
	LatestLedger uint32 `json:"latestLedger"`
}

// GetLedgerEntries fetches entries by base64 LedgerKey. More than
// MaxLedgerEntryKeys keys are split into pages, at most
// ledgerEntryConcurrency in flight; entries come back in page order.
func (c *Client) GetLedgerEntries(ctx context.Context, keys []string) (LedgerEntries, error) {
	if len(keys) == 0 {
		return LedgerEntries{Entries: []LedgerEntry{}}, nil
	}
	var pages [][]string
	for start := 0; start < len(keys); start += MaxLedgerEntryKeys {
		end := min(start+MaxLedgerEntryKeys, len(keys))
		pages = append(pages, keys[start:end])
	}

	results := make([]LedgerEntries, len(pages))
	errs := make([]error, len(pages))
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sem := make(chan struct{}, ledgerEntryConcurrency)
	var wg sync.WaitGroup
	for i, page := range pages {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				errs[i] = ctxError(ctx, "getLedgerEntries")
				return
			}
			defer func() { <-sem }()
			errs[i] = c.call(ctx, "getLedgerEntries", map[string]any{"keys": page}, &results[i])
			if errs[i] != nil {
				cancel() // no point fetching the rest
			}
		}()
	}
	wg.Wait()

	var out LedgerEntries
	out.Entries = []LedgerEntry{}
	for i := range pages {
		if errs[i] != nil {
			return LedgerEntries{}, firstRealError(errs)
		}
		out.Entries = append(out.Entries, results[i].Entries...)
		out.LatestLedger = max(out.LatestLedger, results[i].LatestLedger)
	}
	return out, nil
}

// firstRealError prefers the error that caused a cancellation over the
// cancellations it caused.
func firstRealError(errs []error) error {
	var fallback error
	for _, err := range errs {
		if err == nil {
			continue
		}
		if fallback == nil {
			fallback = err
		}
		if !isCancellation(err) {
			return err
		}
	}
	return fallback
}

func isCancellation(err error) bool {
	return errors.Is(err, context.Canceled)
}

// Transaction answers getTransaction, and is one element of getTransactions.
// Status is SUCCESS, FAILED or NOT_FOUND; the XDR fields are empty for
// NOT_FOUND.
type Transaction struct {
	Status                string   `json:"status"`
	TxHash                string   `json:"txHash,omitempty"`
	LatestLedger          uint32   `json:"latestLedger,omitempty"`
	LatestLedgerCloseTime string   `json:"latestLedgerCloseTime,omitempty"`
	OldestLedger          uint32   `json:"oldestLedger,omitempty"`
	OldestLedgerCloseTime string   `json:"oldestLedgerCloseTime,omitempty"`
	ApplicationOrder      int      `json:"applicationOrder,omitempty"`
	FeeBump               bool     `json:"feeBump,omitempty"`
	EnvelopeXDR           string   `json:"envelopeXdr,omitempty"`
	ResultXDR             string   `json:"resultXdr,omitempty"`
	ResultMetaXDR         string   `json:"resultMetaXdr,omitempty"`
	DiagnosticEventsXDR   []string `json:"diagnosticEventsXdr,omitempty"`
	Ledger                uint32   `json:"ledger,omitempty"`
	CreatedAt             any      `json:"createdAt,omitempty"`
}

// GetTransaction fetches one transaction by hash.
func (c *Client) GetTransaction(ctx context.Context, hash string) (Transaction, error) {
	var r Transaction
	return r, c.call(ctx, "getTransaction", map[string]any{"hash": hash}, &r)
}

// Transactions answers getTransactions.
type Transactions struct {
	Transactions          []Transaction `json:"transactions"`
	LatestLedger          uint32        `json:"latestLedger"`
	LatestLedgerCloseTime int64         `json:"latestLedgerCloseTimestamp"`
	OldestLedger          uint32        `json:"oldestLedger"`
	OldestLedgerCloseTime int64         `json:"oldestLedgerCloseTimestamp"`
	Cursor                string        `json:"cursor"`
}

// GetTransactions pages through transactions from startLedger, or from
// cursor when it is set (the RPC refuses both at once).
func (c *Client) GetTransactions(ctx context.Context, startLedger uint32, cursor string, limit int) (Transactions, error) {
	params := map[string]any{}
	pagination := map[string]any{}
	if cursor != "" {
		pagination["cursor"] = cursor
	} else {
		params["startLedger"] = startLedger
	}
	if limit > 0 {
		pagination["limit"] = limit
	}
	if len(pagination) > 0 {
		params["pagination"] = pagination
	}
	var r Transactions
	return r, c.call(ctx, "getTransactions", params, &r)
}

// EventFilter is one getEvents filter.
type EventFilter struct {
	Type        string     `json:"type,omitempty"` // "contract", "system" or "diagnostic"
	ContractIDs []string   `json:"contractIds,omitempty"`
	Topics      [][]string `json:"topics,omitempty"`
}

// EventsRequest is getEvents' parameters. Set StartLedger or Cursor.
type EventsRequest struct {
	StartLedger uint32
	EndLedger   uint32
	Filters     []EventFilter
	Cursor      string
	Limit       int
}

// Event is one event getEvents returned. Values stay base64 XDR.
type Event struct {
	Type                     string   `json:"type"`
	Ledger                   uint32   `json:"ledger"`
	LedgerClosedAt           string   `json:"ledgerClosedAt"`
	ContractID               string   `json:"contractId"`
	ID                       string   `json:"id"`
	OperationIndex           int      `json:"operationIndex"`
	TransactionIndex         int      `json:"transactionIndex"`
	TxHash                   string   `json:"txHash"`
	InSuccessfulContractCall bool     `json:"inSuccessfulContractCall"`
	Topic                    []string `json:"topic"`
	Value                    string   `json:"value"`
}

// Events answers getEvents.
type Events struct {
	Events       []Event `json:"events"`
	LatestLedger uint32  `json:"latestLedger"`
	Cursor       string  `json:"cursor"`
}

// GetEvents queries contract events.
func (c *Client) GetEvents(ctx context.Context, req EventsRequest) (Events, error) {
	params := map[string]any{}
	pagination := map[string]any{}
	if req.Cursor != "" {
		pagination["cursor"] = req.Cursor
	} else {
		params["startLedger"] = req.StartLedger
	}
	if req.EndLedger > 0 {
		params["endLedger"] = req.EndLedger
	}
	if req.Limit > 0 {
		pagination["limit"] = req.Limit
	}
	if len(pagination) > 0 {
		params["pagination"] = pagination
	}
	filters := req.Filters
	if filters == nil {
		filters = []EventFilter{}
	}
	params["filters"] = filters
	var r Events
	return r, c.call(ctx, "getEvents", params, &r)
}

// SimulateTransaction runs the RPC's own simulation of a base64
// TransactionEnvelope. Only the nightly fidelity check (#575) uses it, so the
// answer is returned as JSON for it to pick apart.
func (c *Client) SimulateTransaction(ctx context.Context, transactionXDR string) (json.RawMessage, error) {
	var r json.RawMessage
	return r, c.call(ctx, "simulateTransaction", map[string]any{"transaction": transactionXDR}, &r)
}
