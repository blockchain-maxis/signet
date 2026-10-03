package pair

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

func TestStart_DeclaresTheDeployKey(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"state":"p_1","pollToken":"tok","expiresAt":"2026-09-04T12:05:00Z"}`)
	}))
	defer srv.Close()

	started, err := New(srv.URL).Start(context.Background(), "testnet", "GABC")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.State != "p_1" || started.PollToken != "tok" {
		t.Fatalf("got %+v", started)
	}
	if got["publicKey"] != "GABC" {
		t.Fatalf("publicKey not declared to the server: %+v", got)
	}
}

// #616: the wire carries the network NAME the command resolved (`--network
// testnet` by default, cmd/link.go), verbatim — not a passphrase. The server
// compares names too, so the value sent here is the value judged there.
func TestStart_SendsTheResolvedNetworkName(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"state":"p_1","pollToken":"tok","expiresAt":"2026-09-29T12:05:00Z"}`)
	}))
	defer srv.Close()

	if _, err := New(srv.URL).Start(context.Background(), "testnet", "GABC"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got["network"] != "testnet" {
		t.Fatalf("start body network = %q, want the resolved name %q", got["network"], "testnet")
	}
}

func TestStart_OmitsPublicKeyWhenUnknown(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_, _ = io.WriteString(w, `{"state":"p_1","pollToken":"tok"}`)
	}))
	defer srv.Close()

	if _, err := New(srv.URL).Start(context.Background(), "testnet", ""); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, present := got["publicKey"]; present {
		t.Fatal("sent an empty publicKey rather than omitting it")
	}
}

func TestPoll_SendsTheTokenAsAQueryParameter(t *testing.T) {
	var gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.URL.Query().Get("pollToken")
		_, _ = io.WriteString(w, `{"status":"approved"}`)
	}))
	defer srv.Close()

	status, err := New(srv.URL).Poll(context.Background(), "tok/with+chars")
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if status != StatusApproved {
		t.Fatalf("status = %q", status)
	}
	if gotToken != "tok/with+chars" {
		t.Fatalf("token round-tripped as %q — not escaped correctly", gotToken)
	}
}

func TestComplete_OmitsHandoffCodeOnTheLoopbackPath(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	if _, _, err := New(srv.URL).Complete(context.Background(), "p_1", "xdr", ""); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if _, present := got["handoffCode"]; present {
		t.Fatal("sent an empty handoffCode, which the server would reject as wrong")
	}
}

func TestDo_SurfacesTheServersOwnMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"This deploy account is already bound to a different profile"}`)
	}))
	defer srv.Close()

	_, _, err := New(srv.URL).Complete(context.Background(), "p_1", "xdr", "")
	if err == nil {
		t.Fatal("expected an error")
	}
	// The server writes these for the person at the terminal; don't bury them.
	if !strings.Contains(err.Error(), "already bound to a different profile") {
		t.Fatalf("error lost the server's message: %v", err)
	}
	if !errors.Is(err, exitcode.ErrNetwork) {
		t.Fatalf("error is not classified: %v", err)
	}
}

// #600: the exit code comes from the body's code, never its message. Before,
// classifyComplete matched "already bound to a different profile", so
// rewording that sentence in complete/route.ts silently turned exit 9 into 6.
func TestDo_MapsByCodeNotMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"Somebody else has this wallet","code":"wallet-bound-elsewhere"}`)
	}))
	defer srv.Close()

	_, _, err := New(srv.URL).Complete(context.Background(), "p_1", "xdr", "")
	if got, _ := exitcode.CodeFor(err); got != exitcode.AlreadyLinked {
		t.Fatalf("exit code = %d, want %d (err: %v)", got, exitcode.AlreadyLinked, err)
	}
	if !strings.Contains(err.Error(), "Somebody else has this wallet") {
		t.Fatalf("error lost the server's message: %v", err)
	}
}

// A code wins over the status: `unavailable` is a configuration problem
// whatever status carried it, and a known refusal on a 503 is still that
// refusal.
func TestDo_ACodeOutranksTheStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"no database","code":"unavailable"}`)
	}))
	defer srv.Close()

	_, err := New(srv.URL).Unlink(context.Background(), "SIGNED")
	if !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("err = %v, want a configuration error", err)
	}
}

// A code this build does not know (a newer server) falls back to the status,
// exactly as a body with no code does.
func TestDo_AnUnknownCodeFallsBackToTheStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":"down for a bit","code":"some-future-code"}`)
	}))
	defer srv.Close()

	_, err := New(srv.URL).Start(context.Background(), "testnet", "GABC")
	if !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("err = %v, want the 503 fallback", err)
	}
}

func TestDo_RedactsSecretsInServerAndRequestErrors(t *testing.T) {
	seed := "SASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"

	t.Run("server message", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"error":"refused `+seed+` identity"}`)
		}))
		defer srv.Close()

		_, _, err := New(srv.URL).Complete(context.Background(), "p_1", "xdr", "")
		if !errors.Is(err, exitcode.ErrNetwork) {
			t.Fatalf("err = %v, want ErrNetwork", err)
		}
		if strings.Contains(err.Error(), seed) || !strings.Contains(err.Error(), "refused "+redact.Placeholder+" identity") {
			t.Fatalf("server error was not safely preserved: %v", err)
		}
	})

	t.Run("request URL", func(t *testing.T) {
		_, err := New("://"+seed).WhoAmI(context.Background(), "GABC")
		if !errors.Is(err, exitcode.ErrNetwork) {
			t.Fatalf("err = %v, want ErrNetwork", err)
		}
		if strings.Contains(err.Error(), seed) || !strings.Contains(err.Error(), redact.Placeholder) {
			t.Fatalf("request error was not redacted: %v", err)
		}
	})
}

func TestUnlink_PostsTheSignedChallengeAndReportsWhatWasRemoved(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_, _ = io.WriteString(w, `{"ok":true,"wallet":"GABC","handle":"alice"}`)
	}))
	defer srv.Close()

	result, err := New(srv.URL).Unlink(context.Background(), "SIGNED")
	if err != nil {
		t.Fatalf("Unlink: %v", err)
	}
	if result.Wallet != "GABC" || result.Handle != "alice" {
		t.Fatalf("result = %+v", result)
	}
	if got["transaction"] != "SIGNED" {
		t.Fatalf("posted %+v", got)
	}
}

func TestUnlink_SurfacesARefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"That wallet is the profile’s primary wallet"}`)
	}))
	defer srv.Close()

	_, err := New(srv.URL).Unlink(context.Background(), "SIGNED")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "primary wallet") {
		t.Fatalf("error lost the server's message: %v", err)
	}
}

func TestDo_A503IsAConfigurationProblemNotANetworkOne(t *testing.T) {
	// #277: a deployment with no database cannot link at all. Reporting that
	// as a network error sends the developer to check their own connection.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":"CLI linking requires a database, and this deployment has none configured."}`)
	}))
	defer srv.Close()

	_, err := New(srv.URL).Start(context.Background(), "testnet", "GABC")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("err = %v, want a configuration error", err)
	}
	if errors.Is(err, exitcode.ErrNetwork) {
		t.Fatal("a missing database is not a network failure")
	}
	if !strings.Contains(err.Error(), "requires a database") {
		t.Fatalf("err lost the server's explanation: %v", err)
	}
}

func TestWhoAmI_ReportsTheHandleAKeyIsAttributedTo(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.URL.Query().Get("publicKey")
		_, _ = io.WriteString(w, `{"publicKey":"GABC","handle":"alice","linked":true,"network":"testnet"}`)
	}))
	defer srv.Close()

	identity, err := New(srv.URL).WhoAmI(context.Background(), "GABC")
	if err != nil {
		t.Fatalf("WhoAmI: %v", err)
	}
	if !identity.Linked || identity.Handle != "alice" {
		t.Fatalf("identity = %+v", identity)
	}
	if gotKey != "GABC" {
		t.Fatalf("queried for %q", gotKey)
	}
}

func TestWhoAmI_ReportsNotLinked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"publicKey":"GABC","handle":null,"linked":false,"network":"testnet"}`)
	}))
	defer srv.Close()

	identity, err := New(srv.URL).WhoAmI(context.Background(), "GABC")
	if err != nil {
		t.Fatalf("WhoAmI: %v", err)
	}
	if identity.Linked || identity.Handle != "" {
		t.Fatalf("identity = %+v, want an unlinked key", identity)
	}
}
