package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// What apps/web/app/.well-known/stellar.toml/route.ts emits on testnet.
const deploymentTOML = `NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
WEB_AUTH_ENDPOINT="https://signet.example/api/auth/sep10"
SIGNING_KEY="GBWMCCC3NHSKLAOJDBKKYW7SSH2PFTTNVFKWSGLWGDLEBKLOVP5JLBBP"
ACCOUNTS=["GBWMCCC3NHSKLAOJDBKKYW7SSH2PFTTNVFKWSGLWGDLEBKLOVP5JLBBP"]
`

func TestDiscover_ReadsTheDeploymentsStellarTOML(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/stellar.toml" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, deploymentTOML)
	}))
	defer srv.Close()

	got, err := client(t, srv.URL, Options{}).Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	want := Discovery{
		URL:               srv.URL,
		NetworkPassphrase: "Test SDF Network ; September 2015",
		SigningKey:        "GBWMCCC3NHSKLAOJDBKKYW7SSH2PFTTNVFKWSGLWGDLEBKLOVP5JLBBP",
		WebAuthEndpoint:   "https://signet.example/api/auth/sep10",
	}
	if got != want {
		t.Fatalf("Discover =\n %+v\nwant\n %+v", got, want)
	}
}

func TestDiscover_IsCachedForTheProcessLifetime(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, deploymentTOML)
	}))
	defer srv.Close()

	// Two clients for the same deployment, as link builds one per command.
	for range 3 {
		if _, err := client(t, srv.URL+"/", Options{}).Discover(context.Background()); err != nil {
			t.Fatalf("Discover: %v", err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("stellar.toml fetched %d times, want 1", calls.Load())
	}
}

func TestDiscover_AMissingDocumentIsA404ErrorAndIsNotCached(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := client(t, srv.URL, Options{})
	for range 2 {
		_, err := c.Discover(context.Background())
		var apiErr *Error
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
			t.Fatalf("err = %v, want a 404 *Error", err)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("a failure was cached: %d fetches, want 2", calls.Load())
	}
}

func TestDiscover_AMisconfiguredDeploymentIsAConfigurationError(t *testing.T) {
	// The route answers 503 with a plain-text comment when SEP-10 has no
	// signing key: the operator's problem, exit 3, after the usual retries.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "# SEP10_SIGNING_SECRET is not set\n")
	}))
	defer srv.Close()

	var waits []time.Duration
	_, err := client(t, srv.URL, instant(&waits)).Discover(context.Background())
	if !errors.Is(err, exitcode.ErrConfiguration) {
		t.Fatalf("err = %v, want ErrConfiguration", err)
	}
}

func TestParseStellarTOML(t *testing.T) {
	cases := map[string]struct {
		doc  string
		want Discovery
	}{
		"spacing, literal strings and trailing comments": {
			doc: "# SEP-1\nNETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015' # mainnet\n  SIGNING_KEY=\"GABC\"\n",
			want: Discovery{
				NetworkPassphrase: "Public Global Stellar Network ; September 2015",
				SigningKey:        "GABC",
			},
		},
		"escapes in a basic string": {
			doc:  `WEB_AUTH_ENDPOINT="https://x/\"auth\"\\path"`,
			want: Discovery{WebAuthEndpoint: `https://x/"auth"\path`},
		},
		"keys under a table are not top-level": {
			doc:  "SIGNING_KEY=\"GTOP\"\n[DOCUMENTATION]\nNETWORK_PASSPHRASE=\"Nested\"\n",
			want: Discovery{SigningKey: "GTOP"},
		},
		"non-string and malformed values are skipped": {
			doc:  "NETWORK_PASSPHRASE=42\nSIGNING_KEY=\"unterminated\nWEB_AUTH_ENDPOINT=\"https://x\" trailing\n",
			want: Discovery{},
		},
		"empty document": {doc: "", want: Discovery{}},
	}
	for name, tc := range cases {
		if got := parseStellarTOML(tc.doc); got != tc.want {
			t.Errorf("%s:\n got %+v\nwant %+v", name, got, tc.want)
		}
	}
}
