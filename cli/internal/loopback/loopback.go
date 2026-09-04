// Package loopback runs the local HTTP server `signet link` hands the
// browser a callback URL for. It binds 127.0.0.1 only (never 0.0.0.0, which
// would expose it to the rest of the network), serves exactly one request,
// and shuts down immediately afterward — so a link attempt can never leave a
// port listening on a developer's machine after the command exits.
package loopback

import (
	"context"
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

// Server is a one-shot loopback HTTP server. Create with New, read Port to
// build the callback URL, then call Wait exactly once to block until that
// callback arrives (or ctx is cancelled, or the timeout elapses).
type Server struct {
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
	if s.waited {
		return nil, ErrAlreadyWaiting
	}
	s.waited = true

	type result struct {
		values url.Values
		err    error
	}
	done := make(chan result, 1)

	mux := http.NewServeMux()
	mux.HandleFunc(s.path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, callbackResponse)
		select {
		case done <- result{values: r.URL.Query()}:
		default:
			// A second request raced the first here — first one wins, this
			// one's result is simply dropped; the shutdown below tears down
			// the listener regardless.
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
