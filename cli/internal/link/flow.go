package link

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/loopback"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

// TTL is how long a pairing is good for, mirroring PAIRING_TTL_MS in
// apps/web/lib/server/pairing.ts. The CLI never waits longer than the code it
// is waiting on remains usable — #265's "the pairing code's own TTL and the
// CLI timeout are consistent".
const TTL = 5 * time.Minute

// PollInterval is how often the fallback path asks the server for progress.
const PollInterval = 2 * time.Second

// Deps are the seams a Flow needs. Every one of them is injected so the whole
// flow is testable against fakes: no browser opens, no port is bound, no
// `stellar` is executed, and no network call leaves the test.
type Deps struct {
	// Start mints the pairing.
	Start func(ctx context.Context, network, publicKey string) (pair.Started, error)
	// Poll reads pairing progress with the poll token.
	Poll func(ctx context.Context, pollToken string) (pair.Status, error)
	// Complete submits the signed challenge and reports what was linked.
	Complete func(ctx context.Context, state, signedXDR, handoffCode string) (string, bool, error)
	// Challenge fetches an unsigned SEP-10 challenge for an account, and the
	// network passphrase the deployment says it was built for.
	Challenge func(ctx context.Context, account string) (unsignedXDR, networkPassphrase string, err error)
	// Sign signs a challenge with the resolved local identity, for the given
	// network passphrase.
	Sign func(unsignedXDR, networkPassphrase string) (string, error)
	// OpenBrowser is best-effort; an error only means the developer opens the
	// URL themselves, never that the link fails.
	OpenBrowser func(target string) error
	// Listen starts the loopback callback server. A nil Callbacks (or an
	// error) drops the flow to the polling path rather than failing — that is
	// the whole point of #273.
	Listen func(path string) (Callbacks, error)
	// Report prints progress to the developer.
	Report func(string)
	// TTL and PollInterval override the package defaults. Zero means "use the
	// default"; tests set them small so the suite does not spend real seconds
	// sleeping.
	TTL          time.Duration
	PollInterval time.Duration
}

// ttl and pollInterval apply the defaults for a zero value.
func (d Deps) ttl() time.Duration {
	if d.TTL > 0 {
		return d.TTL
	}
	return TTL
}

func (d Deps) pollInterval() time.Duration {
	if d.PollInterval > 0 {
		return d.PollInterval
	}
	return PollInterval
}

// Callbacks is the slice of loopback.Server the flow uses, as an interface so
// a test can supply one that never binds a port.
type Callbacks interface {
	URL() string
	WaitFor(ctx context.Context, timeout time.Duration, accept loopback.Accept) (url.Values, error)
	Close() error
}

// Result is what a completed link reports.
type Result struct {
	Handle          string `json:"handle"`
	PublicKey       string `json:"publicKey"`
	Network         string `json:"network"`
	Status          string `json:"status"`
	IndexingPending bool   `json:"indexingPending"`
}

// Run drives the whole flow: mint a pairing, show the developer the approval
// link, wait for them to answer it, then prove control of the deploy key and
// attach the wallet.
//
// Two things wait for the browser at once. The loopback callback finishes the
// moment the page redirects to it, and polling covers every setup where that
// redirect can never arrive — a remote SSH session, a container with an
// unmapped port, a browser locked down against localhost (#273). Whichever
// answers first wins; neither is trusted on its own, because both paths end at
// the same `complete`, which re-checks the browser approval and the signature.
func Run(ctx context.Context, baseURL, network, source, publicKey string, deps Deps) (Result, error) {
	report := deps.Report
	if report == nil {
		report = func(string) {}
	}

	started, err := deps.Start(ctx, network, publicKey)
	if err != nil {
		return Result{}, err
	}

	// The state threaded through the approval link and required back on the
	// callback. Without it any page the developer's browser visits could hit
	// the listening port and abort or hijack the link (#256).
	callbackState, err := loopback.NewState()
	if err != nil {
		return Result{}, err
	}

	approvalURL, server := prepare(baseURL, started, callbackState, deps, report)
	if server != nil {
		defer func() { _ = server.Close() }()
	}

	safeApprovalURL := redact.Secrets(approvalURL)
	report(fmt.Sprintf("Approve this link in your browser:\n\n    %s\n", safeApprovalURL))
	if started.UserCode != "" {
		// The same code the approval page shows (#596). Printed so the
		// developer has something concrete to compare — a page showing a
		// different code is somebody else's link, not theirs.
		report(fmt.Sprintf("The approval page will show this code: %s\n", started.UserCode))
	}
	if deps.OpenBrowser != nil {
		if err := deps.OpenBrowser(approvalURL); err != nil {
			report("Could not open a browser automatically — open the link above yourself.")
		}
	}

	outcome, err := wait(ctx, started, callbackState, server, deps, report)
	if err != nil {
		return Result{}, err
	}
	switch outcome {
	case pair.OutcomeRejected:
		return Result{}, fmt.Errorf(
			"%w: the approval was refused in the browser; nothing was linked",
			exitcode.ErrApprovalRejected,
		)
	case pair.OutcomeExpired, pair.OutcomeTimeout:
		return Result{}, fmt.Errorf(
			"%w: no approval within %s. Run `signet link` again — the approval link was:\n\n    %s",
			exitcode.ErrTimeout, deps.ttl(), safeApprovalURL,
		)
	}

	report("Approved. Proving control of the deploy key…")

	unsigned, passphrase, err := deps.Challenge(ctx, publicKey)
	if err != nil {
		return Result{}, err
	}
	signed, err := deps.Sign(unsigned, passphrase)
	if err != nil {
		return Result{}, err
	}
	// Already classified: pair.Client maps the refusal's code to its exit code
	// (internal/spec/errors.go), so an already-linked wallet exits 9 however
	// the server words it — #258 asks for that failure mode by name.
	handle, indexingPending, err := deps.Complete(ctx, started.State, signed, "")
	if err != nil {
		return Result{}, err
	}

	return Result{
		Handle:          redact.Secrets(handle),
		PublicKey:       redact.Secrets(publicKey),
		Network:         redact.Secrets(network),
		Status:          "linked",
		IndexingPending: indexingPending,
	}, nil
}

// prepare builds the approval URL, attaching the loopback callback when one
// could be bound. A loopback that cannot start is not an error: the polling
// path covers it, and the URL simply carries no callback.
func prepare(baseURL string, started pair.Started, callbackState string, deps Deps, report func(string)) (string, Callbacks) {
	query := url.Values{"code": {started.State}}
	if started.UserCode != "" {
		// /link verifies this against the hash stored at `start` before it
		// renders an Approve button (#596). Omitted when an older server
		// returned none, so the URL stays valid against it.
		query.Set("user_code", started.UserCode)
	}

	var server Callbacks
	if deps.Listen != nil {
		s, err := deps.Listen("/callback")
		if err == nil && s != nil {
			server = s
			query.Set("callback", s.URL())
			query.Set("callback_state", callbackState)
		} else {
			report("Could not open a local callback port — falling back to polling.")
		}
	}

	return strings.TrimRight(baseURL, "/") + "/link?" + query.Encode(), server
}

// wait races the loopback callback against polling, returning whichever
// resolves first.
func wait(
	ctx context.Context,
	started pair.Started,
	callbackState string,
	server Callbacks,
	deps Deps,
	report func(string),
) (pair.Outcome, error) {
	pollOnly := func() (pair.Outcome, error) {
		return pair.WaitForApproval(ctx, pair.WaitOptions{
			TTL:          deps.ttl(),
			PollInterval: deps.pollInterval(),
			GetStatus:    func(c context.Context) (pair.Status, error) { return deps.Poll(c, started.PollToken) },
			Report: func(p pair.Progress) {
				report(fmt.Sprintf("Waiting for approval… %s remaining", p.Remaining.Round(time.Second)))
			},
		})
	}

	if server == nil {
		return pollOnly()
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type answer struct {
		outcome pair.Outcome
		err     error
	}
	results := make(chan answer, 2)

	go func() {
		_, err := server.WaitFor(ctx, deps.ttl(), loopback.MatchState(callbackState))
		if err != nil {
			// The callback never arrived. That is not a failure on its own —
			// the polling half is still running and is the authority here.
			return
		}
		results <- answer{outcome: pair.OutcomeApproved}
	}()
	go func() {
		outcome, err := pollOnly()
		results <- answer{outcome: outcome, err: err}
	}()

	got := <-results
	return got.outcome, got.err
}

// FetchChallenge asks a deployment for an unsigned SEP-10 challenge for
// account, with the network_passphrase the deployment sent alongside it —
// signing needs it, since the passphrase is part of the signed hash. It is the
// `Challenge` dep in production.
func FetchChallenge(client *http.Client, baseURL string) func(context.Context, string) (string, string, error) {
	return func(ctx context.Context, account string) (string, string, error) {
		target := strings.TrimRight(baseURL, "/") + "/api/auth/sep10?account=" + url.QueryEscape(account)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return "", "", fmt.Errorf("%w: building challenge request: %s", exitcode.ErrNetwork, redact.Secrets(err.Error()))
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", "", fmt.Errorf("%w: fetching challenge: %s", exitcode.ErrNetwork, redact.Secrets(err.Error()))
		}
		defer func() { _ = resp.Body.Close() }()

		var body struct {
			Transaction       string `json:"transaction"`
			NetworkPassphrase string `json:"network_passphrase"`
			Error             string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			if body.Error != "" {
				return "", "", fmt.Errorf("%w: %s", exitcode.ErrNetwork, redact.Secrets(body.Error))
			}
			return "", "", fmt.Errorf("%w: challenge request returned %s", exitcode.ErrNetwork, resp.Status)
		}
		if body.Transaction == "" {
			return "", "", fmt.Errorf("%w: challenge response carried no transaction", exitcode.ErrNetwork)
		}
		if body.NetworkPassphrase == "" {
			return "", "", fmt.Errorf("%w: challenge response carried no network_passphrase", exitcode.ErrNetwork)
		}
		return body.Transaction, body.NetworkPassphrase, nil
	}
}
