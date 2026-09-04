// Package loopback runs the local HTTP server `signet link` hands the
// browser a callback URL for. It binds 127.0.0.1 only (never 0.0.0.0, which
// would expose it to the rest of the network), serves exactly one request,
// and shuts down immediately afterward — so a link attempt can never leave a
// port listening on a developer's machine after the command exits.
package loopback

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
)

// ErrAlreadyWaiting is returned by a second call to Wait on the same Server.
var ErrAlreadyWaiting = errors.New("loopback: Wait already called on this server")

// Read/write timeouts on the underlying http.Server — bounds how long a
// single slow or stalled connection can hold the listener open, independent
// of the overall wait timeout passed to Wait.
const (
	readTimeout  = 10 * time.Second
	writeTimeout = 10 * time.Second
)

// callbackResponse is served to the browser once the callback lands, so the
// tab doesn't sit on a blank page — signet itself has already moved on.
const callbackResponse = "Signet: link received. You can close this tab.\n"

// rejectedResponse is served to a callback whose state does not match. It is
// deliberately not an invitation to try again — the only party that should be
// hitting this port already knows the state.
const rejectedResponse = "Signet: this request was not expected. Ignoring it.\n"

// Accept decides whether a callback is the one being waited for. Returning
// false rejects that request *without* ending the wait.
type Accept func(url.Values) bool

// NewState returns a cryptographically random value to thread through the
// approval link and back in the callback.
func NewState() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("loopback: generating state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// MatchState is the Accept that RFC 8252's loopback-redirect hardening calls
// for: the callback must carry exactly the state that went out in the link.
//
// While `signet link` is listening, *any* page the developer's browser visits
// can issue requests to this port. Without this check a hostile page could
// hand the CLI its own payload — linking an attacker-chosen account — or
// simply hit the port to abort the developer's link. Compared in constant time
// out of habit rather than need: the state is not a secret an attacker gets to
// guess a byte at a time, but a timing-safe compare costs nothing here.
func MatchState(expected string) Accept {
	return func(values url.Values) bool {
		got := values.Get("state")
		return subtle.ConstantTimeCompare([]byte(got), []byte(expected)) == 1
	}
}

// Server is a one-shot loopback HTTP server. Create with New, read Port to
// build the callback URL, then call Wait exactly once to block until that
// callback arrives (or ctx is cancelled, or the timeout elapses).
type Server struct {
	// AllowOrigin is the deployment origin (scheme://host[:port]) permitted to
	// reach this listener cross-origin. Empty means no cross-origin request is
	// answered at all — the browser gets a preflight it cannot use, which is
	// the right default for a port that only the local machine should touch.
	//
	// Scoped to one origin rather than `*` on purpose: while this is
	// listening, every page the developer's browser visits can try the port,
	// and a wildcard would let any of them read the response. The `state`
	// check is the real defence; this keeps the browser from even making the
	// request.
	AllowOrigin string

	path     string
	listener net.Listener
	port     int
	waited   bool
}

// New binds an ephemeral port on 127.0.0.1 and prepares to serve exactly one
// request on `path` (e.g. "/callback"). The port is available immediately via
// Port, before Wait is called — callers print the link before blocking.
func New(path string) (*Server, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("loopback: binding 127.0.0.1: %w", err)
	}
	return &Server{
		path:     path,
		listener: listener,
		port:     listener.Addr().(*net.TCPAddr).Port,
	}, nil
}

// Port is the ephemeral port New bound. Zero only if New returned an error.
func (s *Server) Port() int { return s.port }

// URL is the full callback URL to hand the browser, e.g. http://127.0.0.1:54213/callback.
func (s *Server) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", s.port, s.path)
}

// Close releases the listener without waiting for a callback — used when the
// caller gives up before Wait (e.g. failed to open a browser and the user
// cancelled) so the port doesn't sit open for no reason.
func (s *Server) Close() error {
	return s.listener.Close()
}

// Wait blocks until the browser's callback request lands, ctx is cancelled
// (the caller wires SIGINT into ctx via signal.NotifyContext), or timeout
// elapses — whichever comes first — then shuts the server down. It serves at
// most one request: a second request arriving after the first (or after
// cancellation) gets a connection that is already being torn down, never a
// second successful response.
//
// The returned url.Values are the callback request's query parameters.
func (s *Server) Wait(ctx context.Context, timeout time.Duration) (url.Values, error) {
	return s.WaitFor(ctx, timeout, func(url.Values) bool { return true })
}

// WaitFor is Wait, but only a callback that `accept` approves ends it.
//
// A rejected callback is answered and discarded, and the server keeps
// listening — the wait must survive a hostile or stray request rather than
// being terminated by one, which is the whole point of #256. It still serves
// at most one *accepted* callback.
func (s *Server) WaitFor(ctx context.Context, timeout time.Duration, accept Accept) (url.Values, error) {
	if s.waited {
		return nil, ErrAlreadyWaiting
	}
	s.waited = true
	if accept == nil {
		accept = func(url.Values) bool { return true }
	}

	type result struct {
		values url.Values
		err    error
	}
	done := make(chan result, 1)

	mux := http.NewServeMux()
	mux.HandleFunc(s.path, func(w http.ResponseWriter, r *http.Request) {
		// Chrome sends a CORS preflight for any public → private request and
		// requires the private server to opt in explicitly (Private Network
		// Access). Without this the approval page's call fails with an opaque
		// network error and the CLI just times out — working perfectly in
		// local testing, where the page is not served from a public origin.
		if r.Method == http.MethodOptions {
			s.writeCORS(w, r)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.writeCORS(w, r)

		values := r.URL.Query()
		w.Header().Set("content-type", "text/plain; charset=utf-8")

		if !accept(values) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = fmt.Fprint(w, rejectedResponse)
			return
		}

		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, callbackResponse)
		select {
		case done <- result{values: values}:
		default:
			// A second accepted request raced the first here — first one
			// wins, this one's result is simply dropped; the shutdown below
			// tears down the listener regardless.
		}
	})

	srv := &http.Server{
		Handler:      mux,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(s.listener) }()

	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var res result
	select {
	case res = <-done:
	case <-waitCtx.Done():
		res = result{err: waitCtx.Err()}
	}

	// Give the in-flight response (if any) a moment to flush before tearing
	// down, then force-close if graceful shutdown doesn't finish quickly —
	// this is a CLI, not a long-lived service, so there is no reason to wait
	// long here.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer shutdownCancel()
	_ = srv.Shutdown(shutdownCtx)
	<-serveErr

	return res.values, res.err
}

// writeCORS answers a cross-origin request from the deployment's own origin,
// including the Private Network Access opt-in Chrome requires for a public
// page to reach a loopback address.
//
// Anything from another origin gets no CORS headers at all rather than a
// refusal: the browser then blocks it on the caller's side, and this server
// never has to distinguish "hostile page" from "developer typing the URL".
func (s *Server) writeCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if s.AllowOrigin == "" || origin != s.AllowOrigin {
		return
	}

	h := w.Header()
	h.Set("Access-Control-Allow-Origin", s.AllowOrigin)
	// The response varies by Origin, so a cache must not serve one origin's
	// answer to another.
	h.Add("Vary", "Origin")
	h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	h.Set("Access-Control-Max-Age", "600")

	// Only echoed when the browser actually asked — sending it unconditionally
	// claims an opt-in for requests that never requested one.
	if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
		h.Set("Access-Control-Allow-Private-Network", "true")
	}
}
