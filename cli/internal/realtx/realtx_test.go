package realtx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

const contract = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN"

// fakeRPC is an RPC with a retention window of ledgers 1000–1100.
type fakeRPC struct {
	events []rpc.Event
	txs    map[string]rpc.Transaction // what getTransaction finds
	ledger []rpc.Transaction          // what getTransactions pages through
	gets   int
	// oldest is where the RPC's window really starts, when getHealth's
	// answer is already stale.
	oldest uint32
}

func (f *fakeRPC) GetHealth(context.Context) (rpc.Health, error) {
	return rpc.Health{Status: "healthy", LatestLedger: 1100, OldestLedger: 1000, LedgerRetentionWindow: 101}, nil
}

func (f *fakeRPC) GetEvents(_ context.Context, req rpc.EventsRequest) (rpc.Events, error) {
	if f.oldest > 0 && req.Cursor == "" && req.StartLedger < f.oldest {
		return rpc.Events{}, fmt.Errorf("RPC getEvents failed: startLedger must be within the ledger range: %d - 1100 (code -32600)", f.oldest)
	}
	if req.Cursor != "" {
		return rpc.Events{}, nil
	}
	var out []rpc.Event
	for _, e := range f.events {
		if e.Ledger >= req.StartLedger && e.ContractID == req.Filters[0].ContractIDs[0] {
			out = append(out, e)
		}
	}
	return rpc.Events{Events: out, LatestLedger: 1100}, nil
}

func (f *fakeRPC) GetTransactions(_ context.Context, start uint32, cursor string, _ int) (rpc.Transactions, error) {
	if cursor != "" {
		return rpc.Transactions{}, nil
	}
	var out []rpc.Transaction
	for _, t := range f.ledger {
		if t.Ledger >= start {
			out = append(out, t)
		}
	}
	return rpc.Transactions{Transactions: out, LatestLedger: 1100}, nil
}

func (f *fakeRPC) GetTransaction(_ context.Context, hash string) (rpc.Transaction, error) {
	f.gets++
	if t, ok := f.txs[hash]; ok {
		return t, nil
	}
	return rpc.Transaction{Status: "NOT_FOUND"}, nil
}

// decode reads the fake envelopes: "<contract>|<function>" or "create".
func decode(_ context.Context, envelope, _ string) (Decoded, error) {
	var d Decoded
	if envelope == "create" {
		kind := "create_contract"
		d.HostFunction.Kind = &kind
		d.HostFunction.Reason = "only InvokeContract host functions can be replayed"
		return d, nil
	}
	target, fn, _ := strings.Cut(envelope, "|")
	kind := "invoke_contract"
	d.HostFunction.Kind, d.HostFunction.Replayable = &kind, true
	d.HostFunction.ContractID, d.HostFunction.Function = target, fn
	d.SourceAccount = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
	return d, nil
}

func tx(hash string, ledger uint32, envelope string) rpc.Transaction {
	return rpc.Transaction{Status: "SUCCESS", TxHash: hash, Ledger: ledger, EnvelopeXDR: envelope, ResultMetaXDR: "meta"}
}

func names(txs []Tx) []string {
	out := make([]string, len(txs))
	for i, t := range txs {
		out[i] = t.Hash + ":" + t.Function()
	}
	return out
}

type memCache map[string][]byte

func (m memCache) PutTx(h string, raw []byte) error { m[h] = raw; return nil }
func (m memCache) Tx(h string) ([]byte, error)      { return m[h], nil }

func TestEventsFindTransactionsThatEmittedAnEvent(t *testing.T) {
	f := &fakeRPC{
		events: []rpc.Event{{TxHash: "aa", Ledger: 1050, ContractID: contract}, {TxHash: "aa", Ledger: 1050, ContractID: contract}, {TxHash: "bb", Ledger: 1090, ContractID: contract}},
		txs:    map[string]rpc.Transaction{"aa": tx("aa", 1050, contract+"|claim"), "bb": tx("bb", 1090, contract+"|release")},
	}
	cache := memCache{}
	report, err := Collect(context.Background(), f, Options{Contract: contract, Limit: 20, Decode: decode, Cache: cache})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(report.Transactions), " "); got != "bb:release aa:claim" {
		t.Fatalf("newest first, each once: %s", got)
	}
	if report.PerSource[SourceEvents] != 2 || report.From != 1000 || report.To != 1100 {
		t.Fatalf("report: %+v", report)
	}
	if len(cache) != 2 {
		t.Fatalf("cached %d", len(cache))
	}
	// A second collection reads the cache, not RPC.
	gets := f.gets
	if _, err := Collect(context.Background(), f, Options{Contract: contract, Limit: 20, Decode: decode, Cache: cache}); err != nil {
		t.Fatal(err)
	}
	if f.gets != gets {
		t.Fatalf("%d getTransaction calls for cached transactions", f.gets-gets)
	}
	if want := "2 real transactions to replay (ledgers 1000–1100): found 2 by events"; report.Summary() != want {
		t.Fatalf("summary %q", report.Summary())
	}
}

func TestTheScanFindsATransactionThatEmittedNothing(t *testing.T) {
	quiet := tx("cc", 1095, contract+"|count")
	f := &fakeRPC{
		ledger: []rpc.Transaction{quiet, tx("dd", 1096, "COTHER|transfer"), {Status: "FAILED", TxHash: "ee", Ledger: 1097, EnvelopeXDR: contract + "|claim"}},
		txs:    map[string]rpc.Transaction{"cc": quiet},
	}
	report, err := Collect(context.Background(), f, Options{Contract: contract, Limit: 20, ScanLedgers: 10, Decode: decode})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(report.Transactions), " "); got != "cc:count" {
		t.Fatalf("scan found %s", got)
	}
	if report.PerSource[SourceScan] != 1 || report.PerSource[SourceEvents] != 0 {
		t.Fatalf("per source %v", report.PerSource)
	}
}

func TestEachSourceCountsATransactionButItIsReplayedOnce(t *testing.T) {
	claim := tx("aa", 1050, contract+"|claim")
	f := &fakeRPC{
		events: []rpc.Event{{TxHash: "aa", Ledger: 1050, ContractID: contract}},
		ledger: []rpc.Transaction{claim},
		txs:    map[string]rpc.Transaction{"aa": claim},
	}
	report, err := Collect(context.Background(), f, Options{
		Contract: contract, Limit: 20, ScanLedgers: 200, Decode: decode,
		Indexed: func(context.Context) ([]string, error) { return []string{"aa"}, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Transactions) != 1 {
		t.Fatalf("%d replays of one transaction", len(report.Transactions))
	}
	got := report.Transactions[0].Sources
	if len(got) != 3 || report.PerSource[SourceEvents] != 1 || report.PerSource[SourceScan] != 1 || report.PerSource[SourceIndexer] != 1 {
		t.Fatalf("sources %v, per source %v", got, report.PerSource)
	}
}

func TestATransactionOutsideRetentionIsReportedNotDropped(t *testing.T) {
	f := &fakeRPC{txs: map[string]rpc.Transaction{"aa": tx("aa", 1050, contract+"|claim"), "cr": tx("cr", 1060, "create"), "via": tx("via", 1070, "CROUTER|swap")}}
	report, err := Collect(context.Background(), f, Options{
		Contract: contract, Limit: 20, Decode: decode,
		Indexed: func(context.Context) ([]string, error) { return []string{"aa", "old", "cr", "via"}, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.NotRetrievable) != 1 || report.NotRetrievable[0].Hash != "old" ||
		report.NotRetrievable[0].Reason != "not retrievable: outside the RPC's retention window (ledgers 1000–1100)" {
		t.Fatalf("not retrievable: %+v", report.NotRetrievable)
	}
	reasons := map[string]string{}
	for _, s := range report.Skipped {
		reasons[s.Hash] = s.Reason
	}
	if reasons["cr"] != "not replayable: only InvokeContract host functions can be replayed" || !strings.Contains(reasons["via"], "through CROUTER, not directly") {
		t.Fatalf("skipped: %v", reasons)
	}
	if !strings.Contains(report.Summary(), "1 no longer retrievable; 2 skipped") {
		t.Fatal(report.Summary())
	}
}

func TestTheNewestLimitAreKept(t *testing.T) {
	f := &fakeRPC{txs: map[string]rpc.Transaction{}}
	var hashes []string
	for i, h := range []string{"a1", "a2", "a3"} {
		f.txs[h] = tx(h, uint32(1010+i), contract+"|count")
		hashes = append(hashes, h)
	}
	report, _ := Collect(context.Background(), f, Options{Contract: contract, Limit: 2, Decode: decode,
		Indexed: func(context.Context) ([]string, error) { return hashes, nil }})
	if got := strings.Join(names(report.Transactions), " "); got != "a3:count a2:count" {
		t.Fatal(got)
	}
	raw, _ := json.Marshal(report.Transactions[0].Params())
	if !strings.Contains(string(raw), `"auth_mode":"record"`) || !strings.Contains(string(raw), `"source_account":"GAAZ`) {
		t.Fatal(string(raw))
	}
}

func TestAFailedTransactionIsReplayedOnlyWhenAsked(t *testing.T) {
	failed := rpc.Transaction{Status: "FAILED", TxHash: "ff", Ledger: 1080, EnvelopeXDR: contract + "|claim", ResultMetaXDR: "meta"}
	f := &fakeRPC{events: []rpc.Event{{TxHash: "ff", Ledger: 1080, ContractID: contract}}, txs: map[string]rpc.Transaction{"ff": failed}}
	report, _ := Collect(context.Background(), f, Options{Contract: contract, Limit: 20, Decode: decode})
	if len(report.Transactions) != 0 || len(report.Skipped) != 1 || report.Skipped[0].Reason != "failed on-chain (include_failed replays it)" {
		t.Fatalf("without include_failed: %+v", report)
	}
	report, _ = Collect(context.Background(), f, Options{Contract: contract, Limit: 20, Decode: decode, IncludeFailed: true})
	if len(report.Transactions) != 1 || !report.Transactions[0].Failed {
		t.Fatalf("with include_failed: %+v", report)
	}
	tx := report.Transactions[0]
	if !CheckFidelity(tx, nil, &simulator.ContractError{Code: "contract_error"}).High {
		t.Fatal("failing where it failed on-chain is high fidelity")
	}
	if got := CheckFidelity(tx, &simulator.SimulateResult{}, nil); got.High || !strings.Contains(got.Reason, "succeeds here now") {
		t.Fatalf("succeeding now: %+v", got)
	}
}

// Decoded reads tx_decode's answer as the simulator writes it: the
// recorded transcript of a claim on testnet.
func TestDecodedReadsTheSimulatorsAnswer(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "sandbox", "protocol", "transcripts", "xdr_helpers.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range bytes.Split(raw, []byte("\n")) {
		var msg struct {
			Transaction *Decoded `json:"transaction"`
		}
		if json.Unmarshal(line, &msg) != nil || msg.Transaction == nil {
			continue
		}
		d := *msg.Transaction
		tx := Tx{Hash: "93", Ledger: 4878994, Decoded: d}
		if tx.Function() != "claim" || len(tx.ArgsXDR()) != 2 || !d.HostFunction.Replayable || d.SourceAccount == "" {
			t.Fatalf("host function: %+v", d.HostFunction)
		}
		if d.Result == nil || d.Result.ReturnValue == nil || d.Result.ReturnValue.XDR != "AAAAAQ==" || len(d.Result.Events) != 1 || d.Result.Events[0].EventXDR == "" {
			t.Fatalf("result: %+v", d.Result)
		}
		return
	}
	t.Fatal("no tx_decode answer in the transcript")
}

func TestAWindowThatMovedIsRetriedFromWhereTheRPCSaysItStarts(t *testing.T) {
	f := &fakeRPC{
		oldest: 1003,
		events: []rpc.Event{{TxHash: "bb", Ledger: 1090, ContractID: contract}},
		txs:    map[string]rpc.Transaction{"bb": tx("bb", 1090, contract+"|release")},
	}
	report, err := Collect(context.Background(), f, Options{Contract: contract, Limit: 20, Decode: decode})
	if err != nil {
		t.Fatal(err)
	}
	if report.From != 1003 || len(report.Transactions) != 1 {
		t.Fatalf("report: %+v", report)
	}
}
