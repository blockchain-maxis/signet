package cmd

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
	"github.com/blockchain-maxis/signet/cli/internal/devui"
)

// #577: a call saved through POST /api/calls is appended to
// signet.dev.toml as sandbox call --save appends it, comments kept.
func TestTheUISavesACallToSignetDevToml(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, devconfig.FileName)
	original := "# the registry's checks\nversion = 1\n\n# keep this comment\n[[call]]\nname = \"count\"\nfunction = \"count\"\nargs = {}\nexpect = \"unchanged\"\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := devconfig.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	view := &uiSession{setup: &devSetup{file: f, fileDir: dir}}
	api := devui.NewAPI(view, devui.NewEvents())

	rec := httptest.NewRecorder()
	api.ServeHTTP(rec, httptest.NewRequest("POST", "/api/calls", strings.NewReader(`{"name":"resolve alice","function":"resolve","args":{"handle":"alice"},"expect":"ok"}`)))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	raw, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(raw), original) || !strings.Contains(string(raw), `name = "resolve alice"`) {
		t.Fatalf("the file:\n%s", raw)
	}
	saved, err := devconfig.Load(path)
	if err != nil || len(saved.Calls) != 2 || saved.Calls[1].Args["handle"] != "alice" || saved.Calls[1].Expect.Kind != "ok" {
		t.Fatalf("reparsed: %+v %v", saved, err)
	}

	// A duplicate name is the file's rule, reported as a bad request.
	rec = httptest.NewRecorder()
	api.ServeHTTP(rec, httptest.NewRequest("POST", "/api/calls", strings.NewReader(`{"name":"count","function":"count","args":{}}`)))
	if rec.Code != 400 {
		t.Fatalf("duplicate: %d %s", rec.Code, rec.Body.String())
	}

	// Overrides from the file are listed by id.
	rec = httptest.NewRecorder()
	api.ServeHTTP(rec, httptest.NewRequest("GET", "/api/state?layer=override", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"overrides":[]`) {
		t.Fatalf("state: %d %s", rec.Code, rec.Body.String())
	}

	// Without a file there is nowhere to save.
	none := devui.NewAPI(&uiSession{setup: &devSetup{}}, devui.NewEvents())
	rec = httptest.NewRecorder()
	none.ServeHTTP(rec, httptest.NewRequest("POST", "/api/calls", strings.NewReader(`{"function":"count","args":{}}`)))
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "signet dev init") {
		t.Fatalf("no file: %d %s", rec.Code, rec.Body.String())
	}
}
