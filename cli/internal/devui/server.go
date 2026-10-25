// Package devui is the local web server behind `signet dev --ui` (#576).
//
// It can run code against the developer's fork and read their project, and
// every page their browser visits can try to reach it: a cross-site request
// to 127.0.0.1, or DNS rebinding a hostile name onto it. So it is locked down
// before it has any features:
//
//   - it listens on 127.0.0.1 only, on an ephemeral port, with no flag for
//     another interface;
//   - a 32-byte random token per run reaches the browser only in the URL
//     fragment (http://127.0.0.1:<port>/#t=<token>), which never reaches a
//     server log or a Referer, and the SPA sends it back as an
//     `Authorization: Bearer` header: no cookie, so nothing ambient for
//     another site to ride (CSRF-proof by construction);
//   - every request's Host must be exactly 127.0.0.1:<port> or
//     localhost:<port> (DNS rebinding), and a present Origin the same;
//   - no response carries CORS headers, and a preflight (Private Network
//     Access included) is never answered: the UI is same-origin, so no other
//     origin may reach it;
//   - static files are served from one root, `..` refused;
//   - a strict CSP, nosniff, no-referrer, and no-store on the API.
//
// The crate path, RPC, network and host binary are fixed by the CLI
// invocation: no API changes them.
package devui

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/loopback"
)

// CSP is the Content-Security-Policy every response carries: everything from
// the server itself, no inline script, no framing.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
	"connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// Options configure a Server.
type Options struct {
	// Static is the SPA's files, index.html at its root.
	Static fs.FS
	// API serves /api/; it sees only requests that passed every check.
	API http.Handler
	// Logf logs one line per request: method, path (never the query) and
	// status. Nil logs nothing.
	Logf func(format string, args ...any)
}

// Server is the locked-down UI server.
type Server struct {
	opts     Options
	token    string
	listener net.Listener
	port     int
	hosts    map[string]bool
	origins  map[string]bool
	srv      *http.Server
}

// New binds 127.0.0.1:0 and mints the run's token.
func New(opts Options) (*Server, error) {
	token, err := loopback.NewState()
	if err != nil {
		return nil, err
	}
	listener, err := loopback.Listen()
	if err != nil {
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	s := &Server{opts: opts, token: token, listener: listener, port: port, hosts: map[string]bool{}, origins: map[string]bool{}}
	for _, host := range []string{"127.0.0.1", "localhost"} {
		hostport := fmt.Sprintf("%s:%d", host, port)
		s.hosts[hostport] = true
		s.origins["http://"+hostport] = true
	}
	s.srv = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	return s, nil
}

// Addr is the bound address.
func (s *Server) Addr() net.Addr { return s.listener.Addr() }

// URL is what to open: the token rides in the fragment.
func (s *Server) URL() string { return fmt.Sprintf("http://127.0.0.1:%d/#t=%s", s.port, s.token) }

// Serve runs until ctx ends.
func (s *Server) Serve(ctx context.Context) error {
	done := make(chan error, 1)
	go func() { done <- s.srv.Serve(s.listener) }()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.srv.Shutdown(shutdown)
		return nil
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// Close stops the server.
func (s *Server) Close() error { return s.srv.Close() }

// statusWriter remembers the status for the log line.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ServeHTTP applies every check, then serves the API or a static file.
func (s *Server) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	w := &statusWriter{ResponseWriter: rw, status: http.StatusOK}
	defer func() {
		if s.opts.Logf != nil {
			// The path only: a token never travels in it, and the query is
			// left out in case one is ever put there by mistake.
			s.opts.Logf("%s %s %d", r.Method, r.URL.Path, w.status)
		}
	}()
	h := w.Header()
	h.Set("Content-Security-Policy", CSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")

	// DNS rebinding: a hostile name resolved to 127.0.0.1 still carries its
	// own Host.
	if !s.hosts[r.Host] {
		http.Error(w, "forbidden host", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && !s.origins[origin] {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	// Same-origin needs no preflight; never answer one.
	if r.Method == http.MethodOptions {
		http.Error(w, "no cross-origin access", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		h.Set("Cache-Control", "no-store")
		auth := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(auth, "Bearer ")
		if !ok || !loopback.Equal(token, s.token) {
			http.Error(w, "missing or wrong token", http.StatusUnauthorized)
			return
		}
		if s.opts.API == nil {
			http.NotFound(w, r)
			return
		}
		s.opts.API.ServeHTTP(w, r)
		return
	}
	s.static(w, r)
}

// static serves a file from the root, index.html for "/"; anything that
// tries to climb out of the root is not found.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.opts.Static == nil || strings.Contains(r.URL.Path, "..") || strings.Contains(r.URL.Path, "\\") {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}
	if info, err := fs.Stat(s.opts.Static, name); err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	http.ServeFileFS(w, r, s.opts.Static, name)
}
