// Package pair talks to a Signet deployment's CLI pairing API and owns the
// bounded wait `signet link` sits in while the developer approves in the
// browser.
//
// The wait is the reason this package exists separately from the command. A
// naive `for { poll() }` hangs with a blank terminal when the developer never
// finishes — which is the most likely first run, since the browser may not
// have opened at all — and a command that hangs silently reads as broken. So
// the wait here is bounded by the pairing's own TTL, reports progress on every
// poll, and distinguishes "refused" from "ran out of time" so the caller can
// print the right thing and exit with the right code.
package pair

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// Status is a pairing's state as reported by GET /api/cli/pair/status.
type Status string

const (
	StatusPending   Status = "pending"
	StatusApproved  Status = "approved"
	StatusRejected  Status = "rejected"
	StatusCompleted Status = "completed"
	StatusExpired   Status = "expired"
)

// Client calls one Signet deployment's pairing API.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// New builds a Client for baseURL with a timeout on each individual request.
// The overall wait is bounded separately, by Wait — a per-request timeout that
// also had to cover the developer reading a browser prompt would be useless as
// both.
func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 15 * time.Second},
	}
}

// Started is what `POST /api/cli/pair/start` hands back.
type Started struct {
	State     string `json:"state"`
	PollToken string `json:"pollToken"`
	ExpiresAt string `json:"expiresAt"`
}

// Start mints a pairing for the given network passphrase, declaring the deploy
// account the CLI intends to link. The account is not proved here — it is
// declared so the browser approval page can show the developer which key they
// are approving, and the server refuses at `complete` if a different key
// signs.
func (c *Client) Start(ctx context.Context, network, publicKey string) (Started, error) {
	body := map[string]string{"network": network}
	if publicKey != "" {
		body["publicKey"] = publicKey
	}
	var out Started
	if err := c.do(ctx, http.MethodPost, "/api/cli/pair/start", body, &out); err != nil {
		return Started{}, err
	}
	return out, nil
}

// Poll reads a pairing's current status using the poll token from Start.
func (c *Client) Poll(ctx context.Context, pollToken string) (Status, error) {
	var out struct {
		Status Status `json:"status"`
	}
	path := "/api/cli/pair/status?pollToken=" + url.QueryEscape(pollToken)
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return "", err
	}
	return out.Status, nil
}

// Complete submits the signed SEP-10 challenge that attaches the wallet.
// handoffCode is the code the browser showed, and is sent only on the manual
// path — empty means "not applicable", not "empty code".
func (c *Client) Complete(ctx context.Context, state, challengeXDR, handoffCode string) (string, error) {
	body := map[string]string{"state": state, "transaction": challengeXDR}
	if handoffCode != "" {
		body["handoffCode"] = handoffCode
	}
	var out struct {
		Handle string `json:"handle"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/cli/pair/complete", body, &out); err != nil {
		return "", err
	}
	return out.Handle, nil
}

// do issues one request and decodes a JSON response into out (which may be
// nil). A non-2xx response is turned into an error carrying the server's own
// message where it sent one, since those messages are written to be read by
// the person at the terminal.
func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reader *strings.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("%w: encoding request: %w", exitcode.ErrNetwork, err)
		}
		reader = strings.NewReader(string(encoded))
	}

	var req *http.Request
	var err error
	if reader != nil {
		req, err = http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	} else {
		req, err = http.NewRequestWithContext(ctx, method, c.BaseURL+path, nil)
	}
	if err != nil {
		return fmt.Errorf("%w: building request: %w", exitcode.ErrNetwork, err)
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %s: %w", exitcode.ErrNetwork, c.BaseURL, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var problem struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&problem)
		if problem.Error != "" {
			return fmt.Errorf("%w: %s", exitcode.ErrNetwork, problem.Error)
		}
		return fmt.Errorf("%w: %s returned %s", exitcode.ErrNetwork, path, resp.Status)
	}

	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("%w: decoding response: %w", exitcode.ErrNetwork, err)
	}
	return nil
}
