package cmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

const cliWalletKey = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

// indexingDeployment is a testnet deployment where alice's key is linked to
// @alice and stays "indexing" for the first pendingPolls wallet listings
// (forever when pendingPolls < 0). It answers the whole link flow too.
func indexingDeployment(t *testing.T, pendingPolls int32) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/stellar.toml":
			_, _ = w.Write([]byte(testnetStellarTOML))
		case "/api/cli/pair/start":
			_, _ = w.Write([]byte(`{"state":"s","pollToken":"p","userCode":"ABCD2345","expiresAt":"2099-01-01T00:05:00Z"}`))
		case "/api/cli/pair/status":
			_, _ = w.Write([]byte(`{"status":"approved"}`))
		case "/api/cli-link":
			_, _ = w.Write([]byte(`{"transaction":"AAAAchallenge","network_passphrase":"Test SDF Network ; September 2015"}`))
		case "/api/cli/pair/complete":
			_, _ = fmt.Fprintf(w, `{"ok":true,"wallet":%q,"handle":"alice","indexingPending":true,"status":"linked"}`, aliceKey)
		case "/api/v1/health":
			_, _ = w.Write([]byte(`{"data":{"status":"ok","network":"testnet","apiVersion":"1","checks":{"db":"up","registry":"up","pairing":"up","nonceStore":"up","rateLimitStore":"up"}}}`))
		case "/api/v1/lookup/" + aliceKey:
			_, _ = fmt.Fprintf(w, `{"data":{"address":%q,"handle":"alice","source":"cli","isPrimary":false,"network":"testnet"},"meta":{"source":"database"}}`, aliceKey)
		case "/api/v1/profiles/alice/wallets":
			n := polls.Add(1)
			pending := pendingPolls < 0 || n <= pendingPolls
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"address": cliWalletKey, "isPrimary": true, "source": "onchain", "indexingPending": false},
					{"address": aliceKey, "isPrimary": false, "source": "cli", "indexingPending": pending},
				},
				"meta": map[string]string{"source": "db"},
			})
		case "/api/v1/profiles/alice/contracts":
			_, _ = w.Write([]byte(`{"data":[{},{},{}],"meta":{"nextCursor":null,"total":3,"truncated":false,"cap":null,"source":"database"}}`))
		default:
			http.Error(w, "unexpected request "+r.URL.Path, http.StatusTeapot)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &polls
}

func fastWaitPolling(t *testing.T) {
	t.Helper()
	prev := linkWaitInterval
	linkWaitInterval = 10 * time.Millisecond
	t.Cleanup(func() { linkWaitInterval = prev })
}

func TestLinkWait_ReportsTheContractsOnceIndexed(t *testing.T) {
	buildFakeStellarOnPath(t)
	withFakeSigning(t)
	fastLinkPolling(t)
	fastWaitPolling(t)
	isolateConfigDir(t)
	srv, polls := indexingDeployment(t, 3)

	out, err := runSignet(t, "link", "--url", srv.URL, "--source", "alice", "--no-browser", "--wait=10s")
	if err != nil {
		t.Fatalf("link --wait: %v\n%s", err, out)
	}
	if !strings.Contains(out, "indexed: 3 contracts found") {
		t.Fatalf("no contract count:\n%s", out)
	}
	if n := polls.Load(); n != 4 {
		t.Fatalf("polled the wallets %d times, want 4 (3 pending, then indexed)", n)
	}
}

func TestLinkWait_RunningOutOfTimeIsNotAnError(t *testing.T) {
	buildFakeStellarOnPath(t)
	withFakeSigning(t)
	fastLinkPolling(t)
	fastWaitPolling(t)
	isolateConfigDir(t)
	srv, _ := indexingDeployment(t, -1)

	out, err := runSignet(t, "link", "--url", srv.URL, "--source", "alice", "--no-browser", "--wait=1s")
	if err != nil {
		t.Fatalf("link --wait=1s exited non-zero: %v\n%s", err, out)
	}
	if !strings.Contains(out, "still indexing, check `signet status` later") {
		t.Fatalf("no still-indexing message:\n%s", out)
	}

	// --json: the result says so too, and stays one object on stdout.
	root := newRootCmd("dev", "none")
	stdout, stderr := &strings.Builder{}, &strings.Builder{}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetIn(strings.NewReader(""))
	root.SetArgs([]string{"link", "--url", srv.URL, "--source", "alice", "--no-browser", "--wait=200ms", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatalf("link --json: %v", err)
	}
	var got struct {
		Handle   string `json:"handle"`
		Indexing *struct {
			Done bool `json:"done"`
		} `json:"indexing"`
	}
	if err := json.Unmarshal([]byte(stdout.String()), &got); err != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", err, stdout)
	}
	if got.Handle != "alice" || got.Indexing == nil || got.Indexing.Done {
		t.Fatalf("result = %+v, want indexing.done false", got)
	}
}

func TestLinkWithoutWaitDoesNotPoll(t *testing.T) {
	buildFakeStellarOnPath(t)
	withFakeSigning(t)
	fastLinkPolling(t)
	isolateConfigDir(t)
	srv, polls := indexingDeployment(t, -1)

	out, err := runSignet(t, "link", "--url", srv.URL, "--source", "alice", "--no-browser")
	if err != nil {
		t.Fatalf("link: %v\n%s", err, out)
	}
	if polls.Load() != 0 || strings.Contains(out, "indexing") {
		t.Fatalf("link without --wait polled %d times:\n%s", polls.Load(), out)
	}
}

func TestStatus_ShowsIndexingPerWallet(t *testing.T) {
	buildFakeStellarOnPath(t)
	isolateConfigDir(t)
	srv, _ := indexingDeployment(t, -1)

	out, err := runSignet(t, "status", "--url", srv.URL, "--source", "alice")
	if err != nil {
		t.Fatalf("status: %v\n%s", err, out)
	}
	for _, want := range []string{
		"network:    testnet",
		"health:     ok (database up, registry up, pairing up)",
		"publicKey:  " + aliceKey,
		"handle:     @alice",
		cliWalletKey + "  indexed  primary, onchain",
		aliceKey + "  indexing cli, this key",
		"contracts:  3 contracts",
		"The indexer has not scanned every wallet yet",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("status lacks %q:\n%s", want, out)
		}
	}
}

func TestStatus_JSONShape(t *testing.T) {
	buildFakeStellarOnPath(t)
	isolateConfigDir(t)
	srv, _ := indexingDeployment(t, 0)

	root := newRootCmd("dev", "none")
	stdout := &strings.Builder{}
	root.SetOut(stdout)
	root.SetErr(&strings.Builder{})
	root.SetIn(strings.NewReader(""))
	root.SetArgs([]string{"status", "--url", srv.URL, "--source", "alice", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatalf("status --json: %v", err)
	}
	var got statusResult
	if err := json.Unmarshal([]byte(stdout.String()), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, stdout)
	}
	if got.Health == nil || got.Health.Status != "ok" || got.Handle != "alice" || !got.Linked {
		t.Fatalf("result = %+v", got)
	}
	if len(got.Wallets) != 2 || got.Wallets[1].IndexingPending || !got.Wallets[1].This {
		t.Fatalf("wallets = %+v", got.Wallets)
	}
	if got.Contracts == nil || got.Contracts.Count != 3 || got.Contracts.LowerBound {
		t.Fatalf("contracts = %+v", got.Contracts)
	}
	// The documented keys, exactly.
	var keys map[string]json.RawMessage
	_ = json.Unmarshal([]byte(stdout.String()), &keys)
	for _, k := range []string{"deployment", "network", "health", "identity", "publicKey", "handle", "linked", "wallets", "contracts"} {
		if _, ok := keys[k]; !ok {
			t.Fatalf("status --json lacks %q: %s", k, stdout)
		}
	}
}

func TestStatus_AnUnreachableDeploymentIsReportedNotFatal(t *testing.T) {
	buildFakeStellarOnPath(t)
	isolateConfigDir(t)
	// Answers the lookup but not the health check.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/lookup/") {
			serveLookup(w, pair.Identity{PublicKey: aliceKey, Network: "testnet"})
			return
		}
		http.Error(w, "down", http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)

	out, err := runSignet(t, "status", "--url", srv.URL, "--source", "alice")
	if err != nil {
		t.Fatalf("status: %v\n%s", err, out)
	}
	if !strings.Contains(out, "health:     unreachable") || !strings.Contains(out, "handle:     not linked") {
		t.Fatalf("status output:\n%s", out)
	}
}
