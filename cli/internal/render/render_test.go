package render

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden with the current output")

var (
	forkTime = time.Unix(1_790_458_607, 0)
	now      = forkTime.Add(90 * time.Second)
	wallet   = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
)

func provenance() Provenance {
	return Provenance{Network: "testnet", ForkLedger: 4887004, ForkTime: forkTime, Protocol: 29, AuthMocked: true}
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name+".golden")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v; run `go test ./internal/render -update` to create it", err)
	}
	if strings.ReplaceAll(string(want), "\r\n", "\n") != got {
		t.Fatalf("%s differs (- want, + got); run with -update if deliberate:\n- %s\n+ %s",
			path, strings.ReplaceAll(string(want), "\n", "\n- "), strings.ReplaceAll(got, "\n", "\n+ "))
	}
}

func TestRenderings(t *testing.T) {
	drifted := provenance()
	drifted.Drift = 2
	drifted.Overrides = []string{"session demo", "wasm 5c1f…e2 swapped in"}
	unmocked := provenance()
	unmocked.AuthMocked = false

	cases := []struct {
		name string
		call Call
		prov Provenance
	}{
		{"read", Call{Kind: Read, Function: "count", Value: "2"}, unmocked},
		{"read_nothing", Call{Kind: Read, Function: "resolve", Value: "null"}, unmocked},
		{"write_preview", Call{Kind: WritePreview, Function: "claim", Writes: 3, Signers: []string{wallet}}, provenance()},
		{"write_preview_overrides", Call{Kind: WritePreview, Function: "increment", Value: "3", Writes: 1}, drifted},
		{"contract_error", Call{Kind: ContractError, Function: "claim", Error: &Refusal{Name: "HandleTaken", Code: 3, Doc: "That handle is already taken."}}, provenance()},
		{"host_error", Call{Kind: HostError, Function: "run", Error: &Refusal{HostType: "Budget", HostCode: "ExceededLimit"}}, provenance()},
		{"simulator_error", Call{Kind: SimulatorError, Function: "count", Failure: "the simulator exited with status 101 during simulate"}, unmocked},
		{"timeout", Call{Kind: Timeout, Function: "run", Failure: "simulate did not answer within 10s"}, unmocked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := Render(&buf, tc.call, tc.prov, now, Style{}); err != nil {
				t.Fatal(err)
			}
			out := buf.String()
			if !strings.Contains(out, "ran against testnet · fork ledger 4887004") {
				t.Fatalf("no provenance footer:\n%s", out)
			}
			golden(t, tc.name, out)
		})
	}
}

func TestRecordModeAlwaysWarns(t *testing.T) {
	for _, kind := range []Kind{Read, WritePreview} {
		var buf bytes.Buffer
		_ = Render(&buf, Call{Kind: kind, Function: "f", Writes: 1}, provenance(), now, Style{})
		if !strings.Contains(buf.String(), "⚠ auth mocked: signatures were not checked") {
			t.Fatalf("kind %d:\n%s", kind, buf.String())
		}
	}
}

func TestClassify(t *testing.T) {
	if Classify(0, 0, nil) != Read {
		t.Fatal("nothing written and no auth is a read")
	}
	if Classify(0, 1, nil) != WritePreview || Classify(0, 0, []string{wallet}) != WritePreview || Classify(2, 2, nil) != WritePreview {
		t.Fatal("a write or an auth requirement is a write preview")
	}
}

func TestColourOnlyWhenAsked(t *testing.T) {
	var plain, coloured bytes.Buffer
	_ = Render(&plain, Call{Kind: Read, Value: "2"}, provenance(), now, Style{})
	_ = Render(&coloured, Call{Kind: Read, Value: "2"}, provenance(), now, Style{Color: true})
	if strings.Contains(plain.String(), "\x1b[") || !strings.Contains(coloured.String(), "\x1b[32m") {
		t.Fatalf("plain %q / coloured %q", plain.String(), coloured.String())
	}
	t.Setenv("NO_COLOR", "1")
	if StyleFor(os.Stdout).Color {
		t.Fatal("NO_COLOR must turn colour off")
	}
	if StyleFor(&plain).Color {
		t.Fatal("a buffer is not a terminal")
	}
}
