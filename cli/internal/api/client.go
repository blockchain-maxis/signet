// Package api is the one HTTP transport every command talks to a Signet
// deployment through (#601). internal/pair builds its typed pairing methods
// on it, link.FetchChallenge goes through it, and the upcoming `status` and
// `doctor` commands get the same behaviour for free instead of each growing
// its own http.Client, error mapping and retry loop.
//
// A new package rather than hardening pair.Client in place, for the reason
// the issue asks to state: pair's vocabulary is pairing (Start, Poll,
// Complete) and more commands than pairing need the transport — FetchChallenge
// already duplicated the error handling once, which is exactly how the
// behaviours drift apart.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
	"github.com/blockchain-maxis/signet/cli/internal/spec"
)

const (
	defaultRequestTimeout = 15 * time.Second
	defaultMaxAttempts    = 3
	initialBackoff        = 500 * time.Millisecond
	// Retry-After values and computed backoffs are both capped here: a server
	// asking the CLI to come back in ten minutes is answered by giving up and
	// telling the person instead, not by a terminal that sits silent.
	maxBackoff = 30 * time.Second
)

// Error is a deployment's refusal, as one typed value: the HTTP status, the
// machine-readable failure code from the response body (#600), and the
// server's human-readable message. It wraps the matching exit-code sentinel
// (via internal/spec's code table, or ErrNetwork/ErrConfiguration from the
// status when the body carried no known code), so `errors.Is` and
// cmd.ExitCode keep working unchanged.
type Error struct {
	Status  int
	Code    spec.CliFailureCode
	Message string
	kind    error
}

func (e *Error) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%v: %s", e.kind, e.Message)
	}
	return fmt.Sprintf("%v: deployment returned %d", e.kind, e.Status)
}

func (e *Error) Unwrap() error { return e.kind }

// Options tunes a Client. The zero value is production behaviour.
type Options struct {
	// UserAgent overrides the default `signet-cli/dev (<goos>/<goarch>)`.
	// Production passes `signet-cli/<version> (<goos>/<goarch>)`, so a
	// deployment operator can tell CLI traffic (and which release) apart
	// from browsers in their logs and filter on it.
	UserAgent string
	// Insecure permits a plain-http base URL on a non-local host (--insecure).
	// Without it, only localhost/127.0.0.1/::1 may use http: a signed
	// challenge over cleartext to another host is a credential leak, not a
	// preference.
	Insecure bool
	// MaxAttempts bounds tries per request, counting the first. Default 3.
	MaxAttempts int
	// HTTP overrides the underlying client (tests). Default: 15s timeout.
	HTTP *http.Client
	// Sleep overrides backoff waiting (tests). Default honours ctx.
	Sleep func(ctx context.Context, d time.Duration) error
	// Jitter overrides backoff jitter (tests make it deterministic).
	// Default: uniform in [d/2, d).
	Jitter func(d time.Duration) time.Duration
}

// Client issues requests against one deployment.
type Client struct {
	baseURL     string
	userAgent   string
	maxAttempts int
	http        *http.Client
	sleep       func(context.Context, time.Duration) error
	jitter      func(time.Duration) time.Duration
}

// New builds a Client for baseURL.
//
// It refuses a non-https URL for any host other than the loopback ones,
// unless Options.Insecure is set — the transport carries signed SEP-10
// challenges, and those must never cross the network in cleartext.
func New(baseURL string, opts Options) (*Client, error) {
	trimmed := strings.TrimRight(baseURL, "/")
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		// Redacted: a mangled URL can carry a pasted secret (a seed where the
		// host should be), and this message ends up on a terminal.
		return nil, fmt.Errorf("%w: deployment URL %q is not a valid URL", exitcode.ErrConfiguration, redact.Secrets(baseURL))
	}
	if parsed.Scheme != "https" && !opts.Insecure && !isLoopbackHost(parsed.Hostname()) {
		return nil, fmt.Errorf(
			"%w: refusing %q: signed challenges must not travel over plain http to a remote host; use https, or --insecure if you accept the risk",
			exitcode.ErrConfiguration, redact.Secrets(baseURL),
		)
	}

	userAgent := opts.UserAgent
	if userAgent == "" {
		userAgent = UserAgent("dev")
	}
	maxAttempts := opts.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = defaultMaxAttempts
	}
	httpClient := opts.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultRequestTimeout}
	}
	sleep := opts.Sleep
	if sleep == nil {
		sleep = func(ctx context.Context, d time.Duration) error {
			timer := time.NewTimer(d)
			defer timer.Stop()
			select {
			case <-timer.C:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	jitter := opts.Jitter
	if jitter == nil {
		jitter = func(d time.Duration) time.Duration {
			if d <= 0 {
				return 0
			}
			half := d / 2
			return half + time.Duration(rand.Int63n(int64(half)+1))
		}
	}

	return &Client{
		baseURL:     trimmed,
		userAgent:   userAgent,
		maxAttempts: maxAttempts,
		http:        httpClient,
		sleep:       sleep,
		jitter:      jitter,
	}, nil
}

// UserAgent renders the canonical User-Agent for a build:
// `signet-cli/<version> (<goos>/<goarch>)`.
func UserAgent(version string) string {
	if version == "" {
		version = "dev"
	}
	return fmt.Sprintf("signet-cli/%s (%s/%s)", version, runtime.GOOS, runtime.GOARCH)
}

// BaseURL this client talks to, normalised.
func (c *Client) BaseURL() string { return c.baseURL }

// Get issues a GET and decodes the JSON response into out (which may be nil).
// GETs are idempotent by nature, so transient failures are retried.
func (c *Client) Get(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out, true)
}

// Post issues a POST and decodes the JSON response into out. POSTs are NOT
// retried: `complete` moves money-adjacent state, and a lost response does
// not mean the server did nothing.
func (c *Client) Post(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out, false)
}

// PostIdempotent is Post for endpoints the caller knows are safe to repeat —
// the server dedupes, or the operation is a pure read behind a POST. The name
// is the marker the issue requires: retrying a POST is an explicit decision
// at the call site, never a transport default.
func (c *Client) PostIdempotent(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out, true)
}

func (c *Client) do(ctx context.Context, method, path string, body, out any, idempotent bool) error {
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("%w: encoding request: %s", exitcode.ErrNetwork, redact.Secrets(err.Error()))
		}
	}

	backoff := initialBackoff
	for attempt := 1; ; attempt++ {
		_, retryAfter, err := c.once(ctx, method, path, encoded, out)
		if err == nil {
			return nil
		}
		if !idempotent || attempt >= c.maxAttempts || !retryable(err) {
			return err
		}

		delay := c.jitter(backoff)
		if retryAfter > 0 {
			// The server said when to come back; believe it (capped) - do not
			// guess shorter and hammer, do not guess longer and hang.
			delay = min(retryAfter, maxBackoff)
		}
		if sleepErr := c.sleep(ctx, delay); sleepErr != nil {
			return fmt.Errorf("%w: %s", exitcode.ErrTimeout, redact.Secrets(sleepErr.Error()))
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// once performs a single attempt. The second return is the parsed Retry-After
// when the response carried one.
func (c *Client) once(ctx context.Context, method, path string, encoded []byte, out any) (int, time.Duration, error) {
	var reqBody io.Reader
	if encoded != nil {
		reqBody = strings.NewReader(string(encoded))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return 0, 0, fmt.Errorf("%w: building request: %s", exitcode.ErrNetwork, redact.Secrets(err.Error()))
	}
	req.Header.Set("user-agent", c.userAgent)
	if encoded != nil {
		req.Header.Set("content-type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		kind := exitcode.ErrNetwork
		// Both the per-request timeout (net/http reports it as a timeout
		// url.Error) and a caller deadline are "it took too long", which has
		// its own exit code so scripts can tell slow from broken.
		var urlErr *url.Error
		if errors.Is(err, context.DeadlineExceeded) ||
			(errors.As(err, &urlErr) && urlErr.Timeout()) {
			kind = exitcode.ErrTimeout
		}
		return 0, 0, fmt.Errorf("%w: %s", kind, redact.Secrets(c.baseURL+": "+err.Error()))
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if out == nil {
			// Drain so the connection is reusable.
			_, _ = io.Copy(io.Discard, resp.Body)
			return resp.StatusCode, 0, nil
		}
		if text, ok := out.(*rawText); ok {
			// A plain-text document (stellar.toml), not JSON. Bounded: the
			// body comes from whatever answers at the configured URL.
			body, err := io.ReadAll(io.LimitReader(resp.Body, maxTextBytes))
			if err != nil {
				return resp.StatusCode, 0, fmt.Errorf("%w: reading response: %s", exitcode.ErrNetwork, redact.Secrets(err.Error()))
			}
			*text = rawText(body)
			return resp.StatusCode, 0, nil
		}
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return resp.StatusCode, 0, fmt.Errorf("%w: decoding response: %s", exitcode.ErrNetwork, redact.Secrets(err.Error()))
		}
		return resp.StatusCode, 0, nil
	}

	var problem spec.ErrorBody
	_ = json.NewDecoder(resp.Body).Decode(&problem)

	// The body's code decides the exit code (internal/spec/errors.go), never
	// its message: messages are for people and free to change.
	kind, known := spec.ErrorFor(problem.Code)
	if !known {
		kind = exitcode.ErrNetwork
		if resp.StatusCode == http.StatusServiceUnavailable {
			// No database to write a link into (#277): the operator's
			// problem, not the developer's connection.
			kind = exitcode.ErrConfiguration
		}
	}

	message := redact.Secrets(problem.Error)
	if message == "" {
		message = fmt.Sprintf("%s returned %s", redact.Secrets(path), resp.Status)
	}
	return resp.StatusCode, parseRetryAfter(resp.Header.Get("Retry-After")), &Error{
		Status:  resp.StatusCode,
		Code:    problem.Code,
		Message: message,
		kind:    kind,
	}
}

// retryable reports whether another attempt could help. Connection-level
// failures and the transient statuses qualify; everything the server decided
// on purpose does not. A 503 whose body code maps to a configuration problem
// (#600's "no database") is a deployment that cannot do this at all — retrying
// it would just repeat the same answer three times, slowly.
func retryable(err error) bool {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case http.StatusTooManyRequests,
			http.StatusBadGateway,
			http.StatusServiceUnavailable,
			http.StatusGatewayTimeout:
			// A bare 503 maps to ErrConfiguration as the legacy #277
			// fallback, but without a body code it may just as well be a
			// proxy mid-restart - worth another try. Only a 503 whose BODY
			// code named a configuration problem ("no database", #600) is
			// final: the deployment answered deliberately.
			return apiErr.Code == "" || !errors.Is(apiErr, exitcode.ErrConfiguration)
		default:
			return false
		}
	}
	// Not an HTTP refusal: a connection-level failure. A timeout of the
	// caller's own context is terminal, a per-request one is worth retrying.
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	return errors.Is(err, exitcode.ErrNetwork) || errors.Is(err, exitcode.ErrTimeout)
}

// parseRetryAfter handles both forms the header allows: delta-seconds and an
// HTTP date. Unparseable or negative values mean "no advice".
func parseRetryAfter(value string) time.Duration {
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
		if seconds < 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		if d := time.Until(at); d > 0 {
			return d
		}
	}
	return 0
}

func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}
