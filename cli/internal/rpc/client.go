// Package rpc is a thin JSON-RPC client for Stellar RPC: the handful of
// methods forking and replay need, and nothing that parses XDR. Payloads stay
// opaque base64 strings (docs/CLI_RUST_BRIDGE.md: Go never parses XDR); the
// simulator decodes them.
package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const (
	// DefaultTimeout bounds one HTTP attempt.
	DefaultTimeout = 30 * time.Second
	// DefaultRetries is how many times a 429 or 5xx is retried.
	DefaultRetries = 3
)

// Client talks to one RPC endpoint.
type Client struct {
	url     string
	http    *http.Client
	timeout time.Duration
	retries int
	// backoff is the wait before retry n (1-based); tests shorten it.
	backoff func(n int) time.Duration
	nextID  atomic.Uint64
}

// Option configures a Client.
type Option func(*Client)

// WithTimeout sets the per-attempt timeout.
func WithTimeout(d time.Duration) Option { return func(c *Client) { c.timeout = d } }

// WithRetries sets how many times a 429 or 5xx is retried.
func WithRetries(n int) Option { return func(c *Client) { c.retries = n } }

// WithHTTPClient replaces the HTTP client.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithBackoff replaces the retry wait schedule.
func WithBackoff(f func(n int) time.Duration) Option { return func(c *Client) { c.backoff = f } }

// New returns a client for the RPC at url. It does not contact it; Connect
// does, and checks the network.
func New(url string, opts ...Option) *Client {
	c := &Client{
		url:     url,
		http:    &http.Client{},
		timeout: DefaultTimeout,
		retries: DefaultRetries,
		backoff: jitteredBackoff,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// URL is the endpoint this client talks to.
func (c *Client) URL() string { return c.url }

// jitteredBackoff is 250ms doubling per attempt, capped at 4s, with full
// jitter so many clients retrying a rate limit do not retry in step.
func jitteredBackoff(n int) time.Duration {
	ceil := 250 * time.Millisecond << (n - 1)
	if ceil > 4*time.Second || ceil <= 0 {
		ceil = 4 * time.Second
	}
	return time.Duration(rand.Int64N(int64(ceil)) + 1)
}

// Error is a JSON-RPC error object: the RPC answered, and said no.
type Error struct {
	Method  string
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("RPC %s failed: %s (code %d)", e.Method, e.Message, e.Code)
}

func (e *Error) Unwrap() error { return exitcode.ErrNetwork }

// HTTPError is a non-200 answer that was not worth (or ran out of) retries.
type HTTPError struct {
	Method string
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	if e.Body != "" {
		return fmt.Sprintf("RPC %s: HTTP %d: %s", e.Method, e.Status, e.Body)
	}
	return fmt.Sprintf("RPC %s: HTTP %d", e.Method, e.Status)
}

func (e *HTTPError) Unwrap() error { return exitcode.ErrNetwork }

type request struct {
	JSONRPC string `json:"jsonrpc"`
	ID      uint64 `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type response struct {
	Result json.RawMessage `json:"result"`
	Error  *Error          `json:"error"`
}

// call makes one JSON-RPC call, retrying 429 and 5xx with jittered backoff.
// Errors wrap exitcode.ErrTimeout when an attempt ran out of time and
// exitcode.ErrNetwork otherwise.
func (c *Client) call(ctx context.Context, method string, params, result any) error {
	body, err := json.Marshal(request{JSONRPC: "2.0", ID: c.nextID.Add(1), Method: method, Params: params})
	if err != nil {
		return fmt.Errorf("encode %s: %w", method, err)
	}

	for attempt := 0; ; attempt++ {
		raw, retryAfter, err := c.attempt(ctx, method, body)
		if err == nil {
			var resp response
			if err := json.Unmarshal(raw, &resp); err != nil {
				return fmt.Errorf("%w: RPC %s returned a body that is not JSON-RPC: %v", exitcode.ErrNetwork, method, err)
			}
			if resp.Error != nil {
				resp.Error.Method = method
				return resp.Error
			}
			if result == nil {
				return nil
			}
			if err := json.Unmarshal(resp.Result, result); err != nil {
				return fmt.Errorf("%w: RPC %s returned an unexpected result: %v", exitcode.ErrNetwork, method, err)
			}
			return nil
		}

		var he *HTTPError
		retryable := errors.As(err, &he) && (he.Status == http.StatusTooManyRequests || he.Status >= 500)
		if !retryable || attempt >= c.retries {
			return err
		}
		wait := c.backoff(attempt + 1)
		if retryAfter > wait {
			wait = retryAfter
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctxError(ctx, method)
		case <-t.C:
		}
	}
}

// attempt is one HTTP round trip under the per-attempt timeout.
func (c *Client) attempt(ctx context.Context, method string, body []byte) ([]byte, time.Duration, error) {
	actx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(actx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, 0, fmt.Errorf("%w: RPC URL %q: %v", exitcode.ErrConfiguration, c.url, err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctxError(ctx, method)
		}
		var ne net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
			return nil, 0, fmt.Errorf("%w: RPC %s at %s did not answer within %s", exitcode.ErrTimeout, method, c.url, c.timeout)
		}
		return nil, 0, fmt.Errorf("%w: RPC %s at %s: %v", exitcode.ErrNetwork, method, c.url, err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, 0, fmt.Errorf("%w: RPC %s at %s did not finish answering within %s", exitcode.ErrTimeout, method, c.url, c.timeout)
		}
		return nil, 0, fmt.Errorf("%w: RPC %s at %s: reading the answer: %v", exitcode.ErrNetwork, method, c.url, err)
	}
	if resp.StatusCode != http.StatusOK {
		snippet := string(raw)
		if len(snippet) > 200 {
			snippet = snippet[:200] + "…"
		}
		return nil, retryAfterOf(resp), &HTTPError{Method: method, Status: resp.StatusCode, Body: snippet}
	}
	return raw, 0, nil
}

// retryAfterOf reads a Retry-After given in seconds; dates are ignored.
func retryAfterOf(resp *http.Response) time.Duration {
	n, err := strconv.Atoi(resp.Header.Get("Retry-After"))
	if err != nil || n <= 0 {
		return 0
	}
	if n > 30 {
		n = 30
	}
	return time.Duration(n) * time.Second
}

func ctxError(ctx context.Context, method string) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%w: RPC %s: %w", exitcode.ErrTimeout, method, ctx.Err())
	}
	return fmt.Errorf("%w: RPC %s: %w", exitcode.ErrInterrupted, method, ctx.Err())
}
