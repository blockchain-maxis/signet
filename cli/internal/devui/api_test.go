package devui

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeSession records what the API asked of it.
type fakeSession struct {
	calls     []CallRequest
	overrides map[string]Override
	saved     []SavedCall
}

func (f *fakeSession) Info() any { return map[string]any{"contract": "CABC", "lane": 29} }
func (f *fakeSession) Spec(_ context.Context, which string) (json.RawMessage, error) {
	return json.RawMessage(`{"schemaVersion":1,"which":"` + which + `"}`), nil
}
func (f *fakeSession) Wasm(hash string) ([]byte, bool) {
	if hash == "aa" {
		return []byte("\x00asm"), true
	}
	return nil, false
}
func (f *fakeSession) Call(_ context.Context, r CallRequest) (any, error) {
	f.calls = append(f.calls, r)
	if r.Function == "nope" {
		return nil, &InputError{"the contract has no function nope"}
	}
	return map[string]any{"outcome": "result", "returnValue": 2}, nil
}
func (f *fakeSession) Cycle(id string) (any, bool) {
	if id == "latest" || id == "1" {
		return map[string]any{"id": 1, "outcomes": []any{}}, true
	}
	return nil, false
}
func (f *fakeSession) State(_ context.Context, layer string) (any, error) {
	return map[string]any{"layer": layer, "entries": []any{}}, nil
}
func (f *fakeSession) AddOverride(_ context.Context, o Override) (string, error) {
	if o.Durability == "" {
		return "", &InputError{"durability is required"}
	}
	f.overrides["o1"] = o
	return "o1", nil
}
func (f *fakeSession) DeleteOverride(_ context.Context, id string) error {
	if _, ok := f.overrides[id]; !ok {
		return ErrNotFound
	}
	delete(f.overrides, id)
	return nil
}
func (f *fakeSession) SaveCall(_ context.Context, c SavedCall) error {
	f.saved = append(f.saved, c)
	return nil
}

func TestEveryEndpointServesTheSession(t *testing.T) {
	f := &fakeSession{overrides: map[string]Override{}}
	api := NewAPI(f, NewEvents())
	send := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		rec := httptest.NewRecorder()
		api.ServeHTTP(rec, req)
		var v map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &v)
		return rec.Code, v
	}
	for _, tc := range []struct {
		method, path, body string
		status             int
		check              func(map[string]any) bool
	}{
		{"GET", "/api/session", "", 200, func(v map[string]any) bool { return v["contract"] == "CABC" }},
		{"GET", "/api/spec", "", 200, func(v map[string]any) bool { return v["which"] == "deployed" }},
		{"GET", "/api/spec?wasm=local", "", 200, func(v map[string]any) bool { return v["which"] == "local" }},
		{"GET", "/api/spec?wasm=other", "", 400, nil},
		{"GET", "/api/wasm/zz", "", 404, nil},
		{"POST", "/api/call", `{"function":"count","args":{},"auth_mode":"record","ledger":{"sequence":5},"overrides":[{"durability":"instance","key":"Count","value":"u32:3"}],"wasm":"local"}`, 200, func(v map[string]any) bool { return v["outcome"] == "result" }},
		{"POST", "/api/call", `{"function":"nope"}`, 400, func(v map[string]any) bool { return strings.Contains(v["error"].(string), "nope") }},
		{"POST", "/api/call", `{"function":"count","bogus":1}`, 400, nil},
		{"POST", "/api/call", `{"args":{}}`, 400, nil},
		{"GET", "/api/cycles/latest", "", 200, func(v map[string]any) bool { return v["id"] == float64(1) }},
		{"GET", "/api/cycles/9", "", 404, nil},
		{"GET", "/api/state?layer=fork", "", 200, func(v map[string]any) bool { return v["layer"] == "fork" }},
		{"GET", "/api/state?layer=disk", "", 400, nil},
		{"POST", "/api/overrides", `{"durability":"persistent","key":"Owner(\"a\")","value":"true"}`, 200, func(v map[string]any) bool { return v["id"] == "o1" }},
		{"POST", "/api/overrides", `{"key":"K"}`, 400, nil},
		{"DELETE", "/api/overrides/o1", "", 200, nil},
		{"DELETE", "/api/overrides/o1", "", 404, nil},
		{"POST", "/api/calls", `{"name":"count is stable","function":"count","args":{},"expect":"unchanged"}`, 200, func(v map[string]any) bool { return v["saved"] == true }},
	} {
		status, v := send(tc.method, tc.path, tc.body)
		if status != tc.status || (tc.check != nil && !tc.check(v)) {
			t.Errorf("%s %s: %d %v, want %d", tc.method, tc.path, status, v, tc.status)
		}
	}
	if len(f.calls) != 2 || f.calls[0].Wasm != "local" || *f.calls[0].Ledger.Sequence != 5 || f.calls[0].Overrides[0].Value != "u32:3" {
		t.Fatalf("calls: %+v", f.calls)
	}
	if len(f.saved) != 1 || f.saved[0].Expect != "unchanged" {
		t.Fatalf("saved: %+v", f.saved)
	}
	// The wasm endpoint serves bytes.
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, httptest.NewRequest("GET", "/api/wasm/aa", nil))
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/wasm" || rec.Body.String() != "\x00asm" {
		t.Fatalf("wasm: %d %q", rec.Code, rec.Body.String())
	}
}

func TestABodyOverOneMegabyteIsRefused(t *testing.T) {
	api := NewAPI(&fakeSession{overrides: map[string]Override{}}, NewEvents())
	big := `{"function":"count","args":{"x":"` + strings.Repeat("a", MaxBody) + `"}}`
	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, httptest.NewRequest("POST", "/api/call", strings.NewReader(big)))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestTheEventStreamCarriesWhatIsPublished(t *testing.T) {
	events := NewEvents()
	srv := httptest.NewServer(NewAPI(&fakeSession{}, events))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	// The subscription is registered once the headers are out.
	go func() {
		for i := 0; i < 50; i++ {
			events.Publish("build.started", nil)
			events.Publish("cycle.completed", map[string]any{"id": 3})
			time.Sleep(20 * time.Millisecond)
		}
	}()
	lines := bufio.NewScanner(resp.Body)
	seen := map[string]bool{}
	for lines.Scan() && len(seen) < 2 {
		var ev Event
		if err := json.Unmarshal(lines.Bytes(), &ev); err != nil {
			t.Fatalf("%q: %v", lines.Text(), err)
		}
		seen[ev.Type] = true
	}
	if !seen["build.started"] || !seen["cycle.completed"] {
		t.Fatalf("seen %v", seen)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 0))
}
