// Command harness serves the local UI exactly as `signet dev --ui` does (the
// same locked-down server, the same embedded app, the same API handler), over
// a stub session, so the UI's protections (#576) can be tried from a real
// browser without a contract crate, a toolchain or a network (#587).
//
// It prints the UI's URL, token in the fragment, as its first line, and
// serves until stdin closes or it is interrupted. Test use only.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"sync"

	"github.com/blockchain-maxis/signet/cli/internal/devui"
)

type session struct {
	mu        sync.Mutex
	next      int
	overrides []devui.Override
}

func (s *session) Info() any {
	return map[string]any{
		"contract": "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN",
		"network":  map[string]any{"name": "testnet", "passphrase": "Test SDF Network ; September 2015"},
		"fork":     map[string]any{"id": "harness", "ledger": 100, "time": "2026-10-25T00:00:00Z", "consistent": false, "drifted_entries": 0},
		"lane":     29,
		"crate":    map[string]any{"name": "harness", "manifest": "Cargo.toml"},
		"build":    "",
		"config":   map[string]any{"file": "", "calls": 0, "overrides": 0, "ui_overrides": len(s.overrides)},
	}
}

func (s *session) Spec(context.Context, string) (json.RawMessage, error) {
	return nil, &devui.InputError{Msg: "there is no build yet"}
}
func (s *session) Wasm(string) ([]byte, bool) { return nil, false }
func (s *session) Call(context.Context, devui.CallRequest) (any, error) {
	return map[string]any{"outcome": "result", "returnValue": nil}, nil
}
func (s *session) Cycle(string) (any, bool) { return nil, false }

func (s *session) State(_ context.Context, layer string) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if layer == "override" {
		out := append([]devui.Override{}, s.overrides...)
		return map[string]any{"layer": layer, "overrides": out}, nil
	}
	return map[string]any{"layer": layer, "entries": []any{}}, nil
}

func (s *session) AddOverride(_ context.Context, o devui.Override) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	o.ID = "ui-" + strconv.Itoa(s.next)
	s.overrides = append(s.overrides, o)
	return o.ID, nil
}

func (s *session) DeleteOverride(context.Context, string) error { return devui.ErrNotFound }
func (s *session) SaveCall(context.Context, devui.SavedCall) error {
	return &devui.InputError{Msg: "no signet.dev.toml in the harness"}
}

func main() {
	server, err := devui.New(devui.Options{Static: devui.Assets(), API: devui.NewAPI(&session{}, devui.NewEvents())})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(server.URL())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()
	if err := server.Serve(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
