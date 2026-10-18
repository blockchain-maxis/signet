package pair

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestComplete_ReportsTheStatusTheServerSent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"handle":"alice","wallet":"GABC","indexingPending":true,"status":"already-linked"}`)
	}))
	defer srv.Close()

	got, err := New(srv.URL).Complete(context.Background(), "p_1", "xdr", "")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if got.Status != StatusAlreadyLinked || got.Handle != "alice" || !got.IndexingPending {
		t.Fatalf("got %+v", got)
	}
}

func TestComplete_TreatsAMissingStatusAsLinked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"handle":"alice"}`)
	}))
	defer srv.Close()

	got, err := New(srv.URL).Complete(context.Background(), "p_1", "xdr", "")
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if got.Status != StatusLinked {
		t.Fatalf("status = %q, want linked", got.Status)
	}
}
