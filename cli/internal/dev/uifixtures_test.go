package dev

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// TestRecordUICycleFixtures writes the cycles the local UI's A/B diff view
// is tested on (#584): real reload cycles over the #529 fixture contracts.
// It runs only when SIGNET_RECORD_UI_FIXTURES names the directory to write
// to (apps/sandbox-ui/src/fixtures/cycles).
func TestRecordUICycleFixtures(t *testing.T) {
	dir := os.Getenv("SIGNET_RECORD_UI_FIXTURES")
	if dir == "" {
		t.Skip("set SIGNET_RECORD_UI_FIXTURES to record the UI's cycle fixtures")
	}
	ctx := context.Background()
	write := func(name string, id int, c Cycle) {
		raw, err := json.MarshalIndent(struct {
			ID int `json:"id"`
			Cycle
		}{id, c}, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name+".json"), append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The counter (v1 deployed) against a build that returns something else,
	// and one that asks for auth.
	for i, build := range []string{"counter_v2_return", "counter_v2_auth"} {
		host, contract := session(t)
		r, err := NewReloader(ctx, host, contract)
		if err != nil {
			t.Fatal(err)
		}
		c, err := r.Cycle(ctx, fixtureWasm(t, build), replays())
		if err != nil {
			t.Fatal(err)
		}
		write(build, i+1, c)
	}
	// An auth change (#569): increment on the auth build, signed by one
	// account on A and by another on B, diffed as the reloader diffs.
	{
		host, _ := session(t)
		var installed simulator.ContractInstallResult
		if err := call(ctx, host, simulator.TypeContractInstall, simulator.ContractInstallParams{WasmBase64: base64.StdEncoding.EncodeToString(fixtureWasm(t, "counter_v2_auth"))}, &installed); err != nil {
			t.Fatal(err)
		}
		r, err := NewReloader(ctx, host, installed.ContractID)
		if err != nil {
			t.Fatal(err)
		}
		run := func(caller string) Run {
			index := uint64(0)
			res, err := r.simulate(ctx, simulator.SimulateParams{ContractID: installed.ContractID, Function: "increment", Args: map[string]any{"caller": caller}, CallIndex: &index})
			if err != nil {
				t.Fatal(err)
			}
			return res
		}
		o := Outcome{Name: "increment", A: run("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"), B: run("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")}
		if o.Diff, err = r.diff(ctx, o); err != nil {
			t.Fatal(err)
		}
		write("auth_signer_changed", 4, Cycle{Deployed: r.deployed, Local: r.deployed, Outcomes: []Outcome{o}, Simulations: 2})
	}
	// A stored Profile and a build that adds a required field (#571).
	host, _ := session(t)
	var installed simulator.ContractInstallResult
	if err := call(ctx, host, simulator.TypeContractInstall, simulator.ContractInstallParams{WasmBase64: base64.StdEncoding.EncodeToString(fixtureWasm(t, "profile_v1"))}, &installed); err != nil {
		t.Fatal(err)
	}
	index := uint64(100)
	if ce, err := host.Call(ctx, simulator.TypeSimulate, simulator.SimulateParams{ContractID: installed.ContractID, Function: "set_profile",
		Args: map[string]any{"profile": map[string]any{"id": 1, "name": "ada"}}, CallIndex: &index}, nil); err != nil || ce != nil {
		t.Fatalf("set_profile: %v %v", ce, err)
	}
	r, err := NewReloader(ctx, host, installed.ContractID)
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.Cycle(ctx, fixtureWasm(t, "profile_v2_field"), []Replay{
		{Name: "get_profile", Params: simulator.SimulateParams{Function: "get_profile", Args: map[string]any{}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	write("profile_v2_field", 3, c)
}
