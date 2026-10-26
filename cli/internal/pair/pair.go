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
	"errors"
	"net/http"
	"net/url"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/spec"
)

// Status is a pairing's state as reported by GET /api/cli/pair/status. The
// request and response types in this file are aliases for internal/spec's
// generated ones, so they cannot drift from the routes that produce them.
type Status = spec.PollStatus

const (
	StatusPending   = spec.PollStatusPending
	StatusApproved  = spec.PollStatusApproved
	StatusRejected  = spec.PollStatusRejected
	StatusCompleted = spec.PollStatusCompleted
	StatusExpired   = spec.PollStatusExpired
)

// Client calls one Signet deployment's pairing API, over the shared
// internal/api transport (#601): retries with backoff on idempotent calls,
// Retry-After honoured, a User-Agent operators can filter on, and the
// https-only guard, all live there rather than here.
type Client struct {
	api *api.Client
}

// New builds a Client for baseURL with the transport defaults. The overall
// pairing wait is bounded separately, by Wait — a per-request timeout that
// also had to cover the developer reading a browser prompt would be useless
// as both.
func New(baseURL string, opts api.Options) (*Client, error) {
	transport, err := api.New(baseURL, opts)
	if err != nil {
		return nil, err
	}
	return &Client{api: transport}, nil
}

// API exposes the underlying transport, so callers needing endpoints outside
// the pairing vocabulary (link.FetchChallenge, the coming status/doctor) use
// the same client rather than growing a second one.
func (c *Client) API() *api.Client { return c.api }

// BaseURL this client talks to.
func (c *Client) BaseURL() string { return c.api.BaseURL() }

// Started is what `POST /api/cli/pair/start` hands back.
type Started = spec.PairStartResponse

// Start mints a pairing for the given network name, declaring the deploy
// account the CLI intends to link. The account is not proved here — it is
// declared so the browser approval page can show the developer which key they
// are approving, and the server refuses at `complete` if a different key
// signs. An empty publicKey is omitted from the body.
func (c *Client) Start(ctx context.Context, network, publicKey string) (Started, error) {
	body := spec.PairStartRequest{Network: network, PublicKey: publicKey}
	var out Started
	// Not marked idempotent: a retried start could mint a second pairing row
	// mid-flight, and the first URL the terminal printed would then be the
	// wrong one to approve.
	if err := c.api.Post(ctx, "/api/cli/pair/start", body, &out); err != nil {
		return Started{}, err
	}
	return out, nil
}

// Poll reads a pairing's current status using the poll token from Start.
func (c *Client) Poll(ctx context.Context, pollToken string) (Status, error) {
	var out spec.PairStatusResponse
	path := "/api/cli/pair/status?pollToken=" + url.QueryEscape(pollToken)
	if err := c.api.Get(ctx, path, &out); err != nil {
		return "", err
	}
	return out.Status, nil
}

// Completed is what `POST /api/cli/pair/complete` reports back.
type Completed = spec.PairCompleteResponse

// StatusLinked and StatusAlreadyLinked say what complete did for the wallet:
// attached it, or found it already bound to this same profile.
const (
	StatusLinked        = spec.PairCompleteStatusLinked
	StatusAlreadyLinked = spec.PairCompleteStatusAlreadyLinked
)

// Complete submits the signed SEP-10 challenge that attaches the wallet.
// handoffCode is the code the browser showed, and is sent only on the manual
// path — empty means "not applicable", not "empty code".
//
// An older server sends no status; that is reported as a plain link.
func (c *Client) Complete(ctx context.Context, state, challengeXDR, handoffCode string) (Completed, error) {
	body := spec.PairCompleteRequest{State: state, Transaction: challengeXDR, HandoffCode: handoffCode}
	var out Completed
	// Never retried: the signed challenge is single-spend on the server, and
	// a lost response does not mean the server did nothing.
	if err := c.api.Post(ctx, "/api/cli/pair/complete", body, &out); err != nil {
		return Completed{}, err
	}
	if out.Status == "" {
		out.Status = StatusLinked
	}
	return out, nil
}

// Unlinked is what `POST /api/cli/unlink` reports back.
type Unlinked = spec.UnlinkResponse

// Unlink detaches the wallet whose key signed challengeXDR.
//
// No pairing and no browser step: unlinking withdraws an attestation rather
// than making one, so control of the key is the whole proof (see
// apps/web/lib/server/cli-unlink.ts for why that asymmetry is deliberate).
func (c *Client) Unlink(ctx context.Context, challengeXDR string) (Unlinked, error) {
	var out Unlinked
	body := spec.UnlinkRequest{Transaction: challengeXDR}
	if err := c.api.Post(ctx, "/api/cli/unlink", body, &out); err != nil {
		return Unlinked{}, err
	}
	return out, nil
}

// Identity is which handle, if any, a deploy account is attributed to.
type Identity struct {
	PublicKey string `json:"publicKey"`
	Handle    string `json:"handle"`
	Linked    bool   `json:"linked"`
	Network   string `json:"network"`
	// Source is how the wallet was linked (onchain, cli, curated), "" when it
	// is not, or when the deployment predates /api/v1/lookup.
	Source string `json:"source"`
	// IsPrimary is whether it is the handle's on-chain bound wallet.
	IsPrimary bool `json:"isPrimary"`
}

// WhoAmI asks a deployment which handle a deploy account is attributed to.
//
// A plain lookup: the CLI already knows its own key and which deployment it is
// pointed at, and the handle is the one part only the server can answer.
//
// It asks `GET /api/v1/lookup/{address}` (#645), which reports the wallet's
// source and whether it is primary. A deployment older than that route
// answers it 404, and is asked the deprecated `GET /api/cli/whoami` instead.
func (c *Client) WhoAmI(ctx context.Context, publicKey string) (Identity, error) {
	var out struct {
		Data spec.WalletLookup `json:"data"`
	}
	err := c.api.Get(ctx, "/api/v1/lookup/"+url.PathEscape(publicKey), &out)
	var apiErr *api.Error
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		var old spec.WhoamiResponse
		path := "/api/cli/whoami?publicKey=" + url.QueryEscape(publicKey)
		if err := c.api.Get(ctx, path, &old); err != nil {
			return Identity{}, err
		}
		return Identity{PublicKey: old.PublicKey, Handle: old.Handle, Linked: old.Linked, Network: old.Network}, nil
	}
	if err != nil {
		return Identity{}, err
	}
	d := out.Data
	return Identity{
		PublicKey: d.Address,
		Handle:    d.Handle,
		Linked:    d.Handle != "",
		Network:   d.Network,
		Source:    d.Source,
		IsPrimary: d.IsPrimary,
	}, nil
}
