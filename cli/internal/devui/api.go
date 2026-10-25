package devui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
)

// MaxBody caps every request body (#577).
const MaxBody = 1 << 20

// Session is what the UI's API reads and drives: the same session the
// terminal runs (#577), so both see the same results. The CLI implements
// it over signet dev's session; tests use a fake.
type Session interface {
	// Info is the session's provenance: fork, lane, crate, config summary.
	Info() any
	// Spec is a SpecJson document, of the deployed WASM or the local build.
	Spec(ctx context.Context, which string) (json.RawMessage, error)
	// Wasm is an executable the session holds, by hex sha256.
	Wasm(hash string) ([]byte, bool)
	// Call runs one call as `signet sandbox call` would.
	Call(ctx context.Context, req CallRequest) (any, error)
	// Cycle is a reload cycle by id; "latest" for the newest.
	Cycle(id string) (any, bool)
	// State lists entries of one layer: fork, override or session.
	State(ctx context.Context, layer string) (any, error)
	// AddOverride applies a storage override and returns its id;
	// DeleteOverride removes one.
	AddOverride(ctx context.Context, o Override) (string, error)
	DeleteOverride(ctx context.Context, id string) error
	// SaveCall appends a call to signet.dev.toml, as `sandbox call --save`.
	SaveCall(ctx context.Context, c SavedCall) error
}

// CallRequest is POST /api/call: `signet sandbox call`'s parameters.
type CallRequest struct {
	Function      string         `json:"function"`
	Args          map[string]any `json:"args"`
	SourceAccount string         `json:"source_account,omitempty"`
	AuthMode      string         `json:"auth_mode,omitempty"`
	Ledger        *struct {
		Sequence  *uint32 `json:"sequence,omitempty"`
		Timestamp *uint64 `json:"timestamp,omitempty"`
	} `json:"ledger,omitempty"`
	Overrides []Override `json:"overrides,omitempty"`
	// Wasm is "deployed" (the default) or "local", the current build.
	Wasm string `json:"wasm,omitempty"`
}

// Override is a storage override, as --set-storage takes it.
type Override struct {
	ID         string `json:"id,omitempty"`
	Durability string `json:"durability"`
	Key        string `json:"key"`
	Value      string `json:"value,omitempty"`
	Unset      bool   `json:"unset,omitempty"`
}

// SavedCall is POST /api/calls: a [[call]] for signet.dev.toml.
type SavedCall struct {
	Name     string         `json:"name"`
	Function string         `json:"function"`
	Args     map[string]any `json:"args"`
	Expect   string         `json:"expect,omitempty"`
}

// InputError is a request the session refuses for what it asks (400).
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

// ErrNotFound is a missing resource (404).
var ErrNotFound = errors.New("not found")

// NewAPI is the /api/ handler over a session and its event stream.
func NewAPI(s Session, events *Events) http.Handler {
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, v any, err error) {
		w.Header().Set("Content-Type", "application/json")
		var input *InputError
		switch {
		case errors.As(err, &input):
			w.WriteHeader(http.StatusBadRequest)
			v = map[string]string{"error": input.Msg}
		case errors.Is(err, ErrNotFound):
			w.WriteHeader(http.StatusNotFound)
			v = map[string]string{"error": err.Error()}
		case err != nil:
			w.WriteHeader(http.StatusInternalServerError)
			v = map[string]string{"error": err.Error()}
		}
		_ = json.NewEncoder(w).Encode(v)
	}
	decode := func(w http.ResponseWriter, r *http.Request, v any) bool {
		r.Body = http.MaxBytesReader(w, r.Body, MaxBody)
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(v); err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("the body is over %d bytes", MaxBody)})
				return false
			}
			write(w, nil, &InputError{"the body is not the expected JSON: " + err.Error()})
			return false
		}
		return true
	}
	mux.HandleFunc("GET /api/session", func(w http.ResponseWriter, r *http.Request) { write(w, s.Info(), nil) })
	mux.HandleFunc("GET /api/spec", func(w http.ResponseWriter, r *http.Request) {
		which := r.URL.Query().Get("wasm")
		if which == "" {
			which = "deployed"
		}
		if which != "deployed" && which != "local" {
			write(w, nil, &InputError{"wasm must be deployed or local"})
			return
		}
		spec, err := s.Spec(r.Context(), which)
		write(w, spec, err)
	})
	mux.HandleFunc("GET /api/wasm/{hash}", func(w http.ResponseWriter, r *http.Request) {
		wasm, ok := s.Wasm(r.PathValue("hash"))
		if !ok {
			write(w, nil, ErrNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/wasm")
		_, _ = w.Write(wasm)
	})
	mux.HandleFunc("POST /api/call", func(w http.ResponseWriter, r *http.Request) {
		var req CallRequest
		if !decode(w, r, &req) {
			return
		}
		if req.Function == "" {
			write(w, nil, &InputError{"function is required"})
			return
		}
		res, err := s.Call(r.Context(), req)
		write(w, res, err)
	})
	mux.HandleFunc("GET /api/cycles/{id}", func(w http.ResponseWriter, r *http.Request) {
		c, ok := s.Cycle(r.PathValue("id"))
		if !ok {
			write(w, nil, ErrNotFound)
			return
		}
		write(w, c, nil)
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		layer := r.URL.Query().Get("layer")
		if layer != "fork" && layer != "override" && layer != "session" {
			write(w, nil, &InputError{"layer must be fork, override or session"})
			return
		}
		st, err := s.State(r.Context(), layer)
		write(w, st, err)
	})
	mux.HandleFunc("POST /api/overrides", func(w http.ResponseWriter, r *http.Request) {
		var o Override
		if !decode(w, r, &o) {
			return
		}
		id, err := s.AddOverride(r.Context(), o)
		write(w, map[string]string{"id": id}, err)
	})
	mux.HandleFunc("DELETE /api/overrides/{id}", func(w http.ResponseWriter, r *http.Request) {
		err := s.DeleteOverride(r.Context(), r.PathValue("id"))
		write(w, map[string]bool{"deleted": err == nil}, err)
	})
	mux.HandleFunc("POST /api/calls", func(w http.ResponseWriter, r *http.Request) {
		var c SavedCall
		if !decode(w, r, &c) {
			return
		}
		err := s.SaveCall(r.Context(), c)
		write(w, map[string]bool{"saved": err == nil}, err)
	})
	mux.HandleFunc("GET /api/events", events.ServeHTTP)
	return mux
}

// Event is one line of the /api/events stream.
type Event struct {
	Type string `json:"type"` // build.started, build.failed, cycle.completed, drift
	Data any    `json:"data,omitempty"`
}

// Events fans the session's events out to every open /api/events stream,
// as NDJSON over a chunked response: the SPA reads it with fetch, so the
// token goes in a header, which EventSource could not send.
type Events struct {
	mu   sync.Mutex
	subs map[chan Event]bool
}

// NewEvents is an empty broadcaster.
func NewEvents() *Events { return &Events{subs: map[chan Event]bool{}} }

// Publish sends an event to every stream; a stream that cannot keep up
// misses it rather than stall the session.
func (e *Events) Publish(typ string, data any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for ch := range e.subs {
		select {
		case ch <- Event{Type: typ, Data: data}:
		default:
		}
	}
}

func (e *Events) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch := make(chan Event, 64)
	e.mu.Lock()
	e.subs[ch] = true
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.subs, ch)
		e.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	enc := json.NewEncoder(w)
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			if err := enc.Encode(ev); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
