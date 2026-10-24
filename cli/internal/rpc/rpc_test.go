package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const testnetPassphrase = "Test SDF Network ; September 2015"

// fakeRPC is a JSON-RPC endpoint whose answer per method is a function.
type fakeRPC struct {
	t       *testing.T
	mu      sync.Mutex
	calls   map[string]int
	handler map[string]func(params json.RawMessage) (status int, result any)
}

func newFakeRPC(t *testing.T) (*fakeRPC, *httptest.Server) {
	f := &fakeRPC{t: t, calls: map[string]int{}, handler: map[string]func(json.RawMessage) (int, any){}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeRPC) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     uint64          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	f.calls[req.Method]++
	h := f.handler[req.Method]
	f.mu.Unlock()
	if h == nil {
		f.t.Errorf("unexpected method %s", req.Method)
		http.Error(w, "no handler", http.StatusInternalServerError)
		return
	}
	status, result := h(req.Params)
	if status != http.StatusOK {
		w.WriteHeader(status)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
}

func (f *fakeRPC) count(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[method]
}

func noWait(int) time.Duration { return time.Millisecond }

func TestGetLedgerEntriesPagesAt200Keys(t *testing.T) {
	f, srv := newFakeRPC(t)
	var inFlight, peak atomic.Int32
	f.handler["getLedgerEntries"] = func(p json.RawMessage) (int, any) {
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		var params struct{ Keys []string }
		_ = json.Unmarshal(p, &params)
		if len(params.Keys) > MaxLedgerEntryKeys {
			t.Errorf("a page carried %d keys", len(params.Keys))
		}
		var entries []LedgerEntry
		for _, k := range params.Keys {
			entries = append(entries, LedgerEntry{Key: k, XDR: "AAAA", LastModifiedLedgerSeq: 7})
		}
		return http.StatusOK, map[string]any{"entries": entries, "latestLedger": 100}
	}

	keys := make([]string, 450)
	for i := range keys {
		keys[i] = fmt.Sprintf("k%03d", i)
	}
	got, err := New(srv.URL).GetLedgerEntries(context.Background(), keys)
	if err != nil {
		t.Fatalf("GetLedgerEntries: %v", err)
	}
	if n := f.count("getLedgerEntries"); n != 3 {
		t.Fatalf("%d requests for 450 keys, want 3", n)
	}
	if len(got.Entries) != 450 || got.Entries[0].Key != "k000" || got.Entries[449].Key != "k449" {
		t.Fatalf("entries out of order or missing: %d", len(got.Entries))
	}
	if got.LatestLedger != 100 {
		t.Fatalf("latestLedger = %d", got.LatestLedger)
	}
	if p := peak.Load(); p > ledgerEntryConcurrency {
		t.Fatalf("%d pages in flight, want at most %d", p, ledgerEntryConcurrency)
	}
}

func TestA429IsRetried(t *testing.T) {
	f, srv := newFakeRPC(t)
	var n atomic.Int32
	f.handler["getLatestLedger"] = func(json.RawMessage) (int, any) {
		if n.Add(1) == 1 {
			return http.StatusTooManyRequests, nil
		}
		return http.StatusOK, LatestLedger{Sequence: 42, ProtocolVersion: 23}
	}
	got, err := New(srv.URL, WithBackoff(noWait)).GetLatestLedger(context.Background())
	if err != nil || got.Sequence != 42 {
		t.Fatalf("got %+v, %v", got, err)
	}
	if c := f.count("getLatestLedger"); c != 2 {
		t.Fatalf("%d attempts, want 2", c)
	}
}

func TestRetriesRunOutOnPersistent5xx(t *testing.T) {
	f, srv := newFakeRPC(t)
	f.handler["getHealth"] = func(json.RawMessage) (int, any) { return http.StatusBadGateway, nil }
	_, err := New(srv.URL, WithBackoff(noWait), WithRetries(2)).GetHealth(context.Background())
	if !errors.Is(err, exitcode.ErrNetwork) {
		t.Fatalf("err = %v, want a network error", err)
	}
	if c := f.count("getHealth"); c != 3 {
		t.Fatalf("%d attempts, want 1 + 2 retries", c)
	}
}

func TestA4xxOtherThan429IsNotRetried(t *testing.T) {
	f, srv := newFakeRPC(t)
	f.handler["getHealth"] = func(json.RawMessage) (int, any) { return http.StatusForbidden, nil }
	_, err := New(srv.URL, WithBackoff(noWait)).GetHealth(context.Background())
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != http.StatusForbidden {
		t.Fatalf("err = %v", err)
	}
	if c := f.count("getHealth"); c != 1 {
		t.Fatalf("%d attempts, want 1", c)
	}
}

func TestATimeoutMapsToExit7(t *testing.T) {
	f, srv := newFakeRPC(t)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	f.handler["getNetwork"] = func(json.RawMessage) (int, any) {
		<-release
		return http.StatusOK, NetworkInfo{}
	}
	_, err := New(srv.URL, WithTimeout(100*time.Millisecond)).GetNetwork(context.Background())
	if !errors.Is(err, exitcode.ErrTimeout) {
		t.Fatalf("err = %v, want a timeout", err)
	}
	if code, _ := exitcode.CodeFor(err); code != 7 {
		t.Fatalf("exit code %d, want 7", code)
	}
}

func TestAJSONRPCErrorIsANetworkError(t *testing.T) {
	_, srv := newFakeRPC(t)
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid hash"}}`))
	})
	_, err := New(srv.URL).GetTransaction(context.Background(), "nope")
	var re *Error
	if !errors.As(err, &re) || re.Code != -32602 || !errors.Is(err, exitcode.ErrNetwork) {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(err.Error(), "getTransaction") {
		t.Fatalf("message should name the method: %q", err)
	}
}

func TestConnectRefusesAPassphraseMismatch(t *testing.T) {
	f, srv := newFakeRPC(t)
	f.handler["getNetwork"] = func(json.RawMessage) (int, any) {
		return http.StatusOK, NetworkInfo{Passphrase: testnetPassphrase, ProtocolVersion: 23}
	}
	mainnet, err := Select(Selection{Network: "mainnet", RPCURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = Connect(context.Background(), mainnet)
	var pm *PassphraseMismatchError
	if !errors.As(err, &pm) || !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("err = %v, want a passphrase mismatch", err)
	}
	for _, want := range []string{"serves testnet", "mainnet", srv.URL} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message should mention %q: %s", want, err)
		}
	}

	testnet, _ := Select(Selection{Network: "testnet", RPCURL: srv.URL})
	if _, info, err := Connect(context.Background(), testnet); err != nil || info.ProtocolVersion != 23 {
		t.Fatalf("matching network: %+v, %v", info, err)
	}
}

func TestSelect(t *testing.T) {
	cases := []struct {
		name   string
		sel    Selection
		want   Network
		errHas string
	}{
		{name: "testnet default", sel: Selection{}, want: Network{"testnet", testnetPassphrase, DefaultTestnetURL}},
		{name: "flag wins over config", sel: Selection{Network: "testnet", RPCURL: "https://a", ConfigRPCURL: "https://b"}, want: Network{"testnet", testnetPassphrase, "https://a"}},
		{name: "config rpcUrl", sel: Selection{Network: "testnet", ConfigRPCURL: "https://b"}, want: Network{"testnet", testnetPassphrase, "https://b"}},
		{name: "mainnet alias with a URL", sel: Selection{Network: "pubnet", RPCURL: "https://m"}, want: Network{"mainnet", "Public Global Stellar Network ; September 2015", "https://m"}},
		{name: "mainnet needs a URL", sel: Selection{Network: "mainnet"}, errHas: "mainnet has no default RPC URL"},
		{name: "custom network", sel: Selection{Network: "mynet", Passphrase: "My Net", RPCURL: "http://x"}, want: Network{"mynet", "My Net", "http://x"}},
		{name: "custom network needs a passphrase", sel: Selection{Network: "mynet", RPCURL: "http://x"}, errHas: "--network-passphrase"},
		{name: "conflicting passphrase", sel: Selection{Network: "testnet", Passphrase: "Other"}, errHas: "is not testnet's passphrase"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Select(tc.sel)
			if tc.errHas != "" {
				if err == nil || !strings.Contains(err.Error(), tc.errHas) || !errors.Is(err, exitcode.ErrConfiguration) {
					t.Fatalf("err = %v, want a configuration error mentioning %q", err, tc.errHas)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("Select = %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}

func TestPaginatedMethodsSendTheRightParams(t *testing.T) {
	f, srv := newFakeRPC(t)
	var seen []string
	var mu sync.Mutex
	record := func(p json.RawMessage) {
		mu.Lock()
		seen = append(seen, string(p))
		mu.Unlock()
	}
	f.handler["getTransactions"] = func(p json.RawMessage) (int, any) {
		record(p)
		return http.StatusOK, Transactions{Cursor: "c2"}
	}
	f.handler["getEvents"] = func(p json.RawMessage) (int, any) {
		record(p)
		return http.StatusOK, Events{Cursor: "e2"}
	}
	c := New(srv.URL)
	ctx := context.Background()
	if r, err := c.GetTransactions(ctx, 10, "", 5); err != nil || r.Cursor != "c2" {
		t.Fatal(r, err)
	}
	if _, err := c.GetTransactions(ctx, 10, "c2", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetEvents(ctx, EventsRequest{StartLedger: 3, Filters: []EventFilter{{Type: "contract", ContractIDs: []string{"C1"}}}, Limit: 2}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		`{"pagination":{"limit":5},"startLedger":10}`,
		`{"pagination":{"cursor":"c2"}}`,
		`{"filters":[{"type":"contract","contractIds":["C1"]}],"pagination":{"limit":2},"startLedger":3}`,
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Errorf("params %d = %s, want %s", i, seen[i], want[i])
		}
	}
}
