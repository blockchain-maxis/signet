package cmd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/localnet"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// localnetFlags are signet dev's --localnet flags (#588, #589, #590).
type localnetFlags struct {
	on       bool
	limits   string
	bindings string
	seed     bool
}

func addLocalnetFlags(cmd *cobra.Command, f *localnetFlags) {
	cmd.Flags().BoolVar(&f.on, "localnet", false, "also run a local network (Stellar Quickstart, in Docker) with the current build deployed to it, redeployed after every successful build")
	cmd.Flags().StringVar(&f.limits, "localnet-limits", "", "with --localnet, the resource limits a new local network starts with (stellar container start --limits)")
	cmd.Flags().StringVar(&f.bindings, "localnet-bindings", "", "with --localnet, write TypeScript bindings for the contract into this directory after each deploy")
	cmd.Flags().BoolVar(&f.seed, "localnet-seed", false, "with --localnet, run the [[call]]s marked seed = true as real transactions after each fresh deploy")
}

func (f localnetFlags) check(cmd *cobra.Command, ci bool) error {
	sub := cmd.Flags().Changed("localnet-limits") || cmd.Flags().Changed("localnet-bindings") || f.seed
	switch {
	case f.on && ci:
		return &inputError{"--localnet runs alongside an interactive signet dev; it does not go with --ci"}
	case sub && !f.on:
		return &inputError{"--localnet-limits, --localnet-bindings and --localnet-seed go with --localnet"}
	}
	return nil
}

// devLocalnet is the local network for one signet dev session.
type devLocalnet struct {
	session  *localnet.Session
	sim      *devSession
	protocol int
	progress func(string)
}

// startLocalnet finds or starts the local network and prepares deploys to it.
func startLocalnet(ctx context.Context, f localnetFlags, binary string, protocol int, dir string, setup devSetup, s *devSession, out io.Writer, progress func(string)) (*devLocalnet, error) {
	n, err := localnet.Start(ctx, localnet.Options{Stellar: binary, Protocol: protocol, Limits: f.limits, Progress: progress})
	if err != nil {
		return nil, err
	}
	ls := &localnet.Session{
		Net: n, Dir: filepath.Join(dir, ".signet"), Bindings: f.bindings,
		ForkContract: setup.contract, Out: out,
	}
	if f.seed {
		ls.Seed = []localnet.SeedCall{}
		if setup.file != nil {
			for _, c := range setup.file.Calls {
				if c.Seed {
					ls.Seed = append(ls.Seed, localnet.SeedCall{Name: c.Name, Function: c.Function, Args: c.Args})
				}
			}
		}
	}
	return &devLocalnet{session: ls, sim: s, protocol: protocol, progress: progress}, nil
}

// deploy brings the local network to the build at wasm. A failure is said and
// the session goes on: the fork is the main loop, localnet is extra.
func (l *devLocalnet) deploy(ctx context.Context, wasm string) {
	iface, err := l.sim.inspect(ctx, wasm, l.protocol)
	if err == nil {
		_, err = l.session.Deploy(ctx, wasm, iface)
	}
	if err != nil && ctx.Err() == nil {
		l.progress("localnet: deploy failed: " + err.Error())
	}
}

// inspect reads what a deploy needs from a build: whether it can replace its
// own code (wasm_inspect) and its functions' inputs (spec_extract).
func (s *devSession) inspect(ctx context.Context, wasmPath string, protocol int) (localnet.Interface, error) {
	raw, err := os.ReadFile(wasmPath)
	if err != nil {
		return localnet.Interface{}, err
	}
	b64 := base64.StdEncoding.EncodeToString(raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	var inspected simulator.WasmInspectResult
	if _, err := callSimulator(ctx, s.sim, simulator.TypeWasmInspect, simulator.WasmInspectParams{LedgerProtocol: &protocol, WasmBase64: b64}, &inspected); err != nil {
		return localnet.Interface{}, err
	}
	var extracted simulator.SpecExtractResult
	if _, err := callSimulator(ctx, s.sim, simulator.TypeSpecExtract, simulator.SpecExtractParams{Source: simulator.Source{WasmBase64: b64}}, &extracted); err != nil {
		return localnet.Interface{}, err
	}
	var spec struct {
		Functions []struct {
			Name   string `json:"name"`
			Inputs []struct {
				Name string `json:"name"`
				Type struct {
					Type string `json:"type"`
					N    int    `json:"n"`
				} `json:"type"`
			} `json:"inputs"`
		} `json:"functions"`
	}
	if err := json.Unmarshal(extracted.Spec, &spec); err != nil {
		return localnet.Interface{}, fmt.Errorf("reading the build's spec: %w", err)
	}
	iface := localnet.Interface{Upgradeable: inspected.Upgradeable != "" && inspected.Upgradeable != "none", Functions: map[string][]localnet.Param{}}
	for _, fn := range spec.Functions {
		params := []localnet.Param{}
		for _, in := range fn.Inputs {
			params = append(params, localnet.Param{Name: in.Name, Type: in.Type.Type, N: in.Type.N})
		}
		iface.Functions[fn.Name] = params
	}
	return iface, nil
}
