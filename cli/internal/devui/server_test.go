package devui

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

type logCapture struct {
	mu    sync.Mutex
	lines []string
}

func (l *logCapture) Logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func start(t *testing.T) (*Server, *logCapture) {
	t.Helper()
	logs := &logCapture{}
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{"ok":true}`) })
	s, err := New(Options{
		Static: fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>signet dev</title>")}, "app.js": {Data: []byte("1")}},
		API:    api,
		Logf:   logs.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = s.Serve(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return s, logs
}

// reply is a response's status and headers; do has read and closed it.
type reply struct {
	StatusCode int
	Header     http.Header
}

// do sends one request to the server's port, with Host and headers as
// given (the Go client would otherwise set Host from the URL).
func do(t *testing.T, s *Server, method, path, host string, headers map[string]string) reply {
	t.Helper()
	req, err := http.NewRequest(method, "http://"+s.Addr().String()+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = host
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return reply{resp.StatusCode, resp.Header}
}

func token(s *Server) string { return strings.SplitN(s.URL(), "#t=", 2)[1] }

func TestTheServerListensOnLoopbackOnly(t *testing.T) {
	s, _ := start(t)
	if ip := s.Addr().(*net.TCPAddr).IP; !ip.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("listening on %s", ip)
	}
	if !strings.HasPrefix(s.URL(), fmt.Sprintf("http://127.0.0.1:%d/#t=", s.Addr().(*net.TCPAddr).Port)) || len(token(s)) != 43 {
		t.Fatalf("url %s", s.URL())
	}
}

func TestEveryRequestIsChecked(t *testing.T) {
	s, logs := start(t)
	host := s.Addr().String()
	bearer := map[string]string{"Authorization": "Bearer " + token(s)}
	for _, tc := range []struct {
		name, method, path, host string
		headers                  map[string]string
		want                     int
	}{
		{"no token", "GET", "/api/health", host, nil, 401},
		{"a wrong token", "GET", "/api/health", host, map[string]string{"Authorization": "Bearer nope"}, 401},
		{"a token as a cookie", "GET", "/api/health", host, map[string]string{"Cookie": "t=" + token(s)}, 401},
		{"a rebinding host", "GET", "/api/health", "evil.example:" + strings.Split(host, ":")[1], bearer, 403},
		{"another port", "GET", "/", "127.0.0.1:1", nil, 403},
		{"a foreign origin", "GET", "/api/health", host, map[string]string{"Authorization": bearer["Authorization"], "Origin": "https://evil.example"}, 403},
		{"token and host", "GET", "/api/health", host, bearer, 200},
		{"localhost and its origin", "GET", "/api/health", "localhost:" + strings.Split(host, ":")[1], map[string]string{"Authorization": bearer["Authorization"], "Origin": "http://localhost:" + strings.Split(host, ":")[1]}, 200},
		{"the page", "GET", "/", host, nil, 200},
		{"a file", "GET", "/app.js", host, nil, 200},
		{"a climb out of the root", "GET", "/../../etc/passwd", host, nil, 404},
		{"an encoded climb", "GET", "/%2e%2e/%2e%2e/etc/passwd", host, nil, 404},
		{"a missing file", "GET", "/nope.js", host, nil, 404},
	} {
		resp := do(t, s, tc.method, tc.path, tc.host, tc.headers)
		if resp.StatusCode != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, resp.StatusCode, tc.want)
		}
		for k := range resp.Header {
			if strings.HasPrefix(k, "Access-Control-") {
				t.Errorf("%s: %s header", tc.name, k)
			}
		}
		if resp.Header.Get("Content-Security-Policy") != CSP || resp.Header.Get("X-Content-Type-Options") != "nosniff" || resp.Header.Get("Referrer-Policy") != "no-referrer" {
			t.Errorf("%s: security headers %v", tc.name, resp.Header)
		}
	}
	if resp := do(t, s, "GET", "/api/health", host, bearer); resp.Header.Get("Cache-Control") != "no-store" {
		t.Error("the API is cacheable")
	}
	// The token is in no log line.
	logs.mu.Lock()
	defer logs.mu.Unlock()
	if len(logs.lines) == 0 {
		t.Fatal("nothing logged")
	}
	for _, line := range logs.lines {
		if strings.Contains(line, token(s)) {
			t.Fatalf("the token was logged: %q", line)
		}
	}
}

// A Private Network Access preflight from another site gets nothing it can
// use.
func TestAPreflightIsNeverAnswered(t *testing.T) {
	s, _ := start(t)
	resp := do(t, s, "OPTIONS", "/api/health", s.Addr().String(), map[string]string{
		"Origin":                                 "https://evil.example",
		"Access-Control-Request-Method":          "GET",
		"Access-Control-Request-Private-Network": "true",
	})
	if resp.StatusCode < 400 {
		t.Fatalf("preflight answered %d", resp.StatusCode)
	}
	for k := range resp.Header {
		if strings.HasPrefix(k, "Access-Control-Allow-") {
			t.Fatalf("%s: %s", k, resp.Header.Get(k))
		}
	}
}

// #579: the embedded UI when it was built, the page saying how to build it
// when it was not; either way a page with no inline script, which the CSP
// would refuse.
func TestTheBuiltUIOrThePlaceholderIsServed(t *testing.T) {
	assets := Assets()
	page, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if Built() {
		if !strings.Contains(string(page), `type="module"`) || !strings.Contains(string(page), "./assets/") {
			t.Fatalf("the built page:\n%s", page)
		}
	} else if !strings.Contains(string(page), "pnpm --filter @signet/sandbox-ui build") {
		t.Fatalf("the placeholder:\n%s", page)
	}
	if strings.Contains(string(page), "<script>") || strings.Contains(string(page), "style=") {
		t.Fatalf("inline script or style, which the CSP blocks:\n%s", page)
	}
	s, err := New(Options{Static: assets})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = s.Serve(ctx) }()
	if r := do(t, s, "GET", "/", s.Addr().String(), nil); r.StatusCode != 200 {
		t.Fatalf("GET / = %d", r.StatusCode)
	}
}
