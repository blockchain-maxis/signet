package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
)

// doctorReport is `signet sandbox doctor --json`
// (sandbox/protocol/schema/v1/cli-sandbox-doctor.json).
type doctorReport struct {
	CLI struct {
		Version string `json:"version"`
	} `json:"cli"`
	Simulator *doctorSimulator `json:"simulator"`
	// SimulatorError says why there is no simulator to report on.
	SimulatorError string          `json:"simulatorError,omitempty"`
	Networks       []doctorNetwork `json:"networks"`
	Tools          []doctorTool    `json:"tools"`
	Cache          doctorCache     `json:"cache"`
}

type doctorSimulator struct {
	Version string       `json:"version"`
	Commit  string       `json:"commit"`
	Lanes   []doctorLane `json:"lanes"`
}

type doctorLane struct {
	Protocol   int    `json:"protocol"`
	EnvHost    string `json:"envHost"`
	Simulation string `json:"simulation"`
}

// doctorNetwork is one network's live protocol and whether a lane runs it:
// ok, ahead (of the lanes), behind, gap, or unreachable.
type doctorNetwork struct {
	Name     string `json:"name"`
	RPCURL   string `json:"rpcUrl"`
	Protocol *int   `json:"protocol"`
	Verdict  string `json:"verdict"`
	Message  string `json:"message,omitempty"`
}

type doctorTool struct {
	Name    string `json:"name"`
	Status  string `json:"status"` // ok, missing, not running
	Version string `json:"version,omitempty"`
	Note    string `json:"note,omitempty"`
}

type doctorCache struct {
	// Path is ~-relative: a report is pasted into issues.
	Path  string `json:"path"`
	Forks int    `json:"forks"`
	Bytes int64  `json:"bytes"`
}

// runTool runs a tool for its version; tests replace it.
var runTool = func(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return strings.TrimSpace(string(out)), err
}

// tildePath writes a path under the home directory as ~/…, so a pasted
// report does not carry a username.
func tildePath(p string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	if rel, err := filepath.Rel(home, p); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.Join("~", rel)
	}
	return p
}

func newSandboxDoctorCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "doctor",
		Short: "Check the simulator's protocol lanes against the networks, and the tools signet dev uses",
		Long: `Check whether the sandbox can run against your networks, and why not.

Prints the CLI's and the simulator's versions, the simulator's lanes (the
ledger protocols it runs, and the host each links), the live protocol of the
selected network (and testnet), with a verdict for each, the stellar, cargo
and Docker (for --localnet) versions, and the fork cache's size.

A network the simulator has no lane for is never run on the wrong host: the
verdict says whether the network is ahead of the simulator (upgrade
@signet/cli), behind it (an older release has its lane), or in a gap. Exits
11 when a checked network has no lane, 3 when there is no simulator.`,
		Example: `  signet sandbox doctor
  signet sandbox doctor --network mainnet --rpc-url https://mainnet.example/rpc --json`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			printer := printerFor(cmd)
			report := doctorReport{}
			report.CLI.Version = deps.Version
			ctx := cmd.Context()

			var lanes []int
			if sim, err := startSimulator(ctx, deps, func(string) {}); err != nil {
				report.SimulatorError = err.Error()
			} else {
				ack := sim.HelloAck()
				_ = sim.Close()
				s := &doctorSimulator{Version: ack.SimulatorVersion, Commit: ack.Commit}
				for _, l := range ack.Lanes {
					s.Lanes = append(s.Lanes, doctorLane{Protocol: l.LedgerProtocol, EnvHost: l.EnvHost, Simulation: l.Simulation})
					lanes = append(lanes, l.LedgerProtocol)
				}
				report.Simulator = s
			}

			networks := []rpc.Network{}
			if selected, err := sandboxNetwork(cmd, deps); err == nil {
				networks = append(networks, selected)
			} else {
				report.Networks = append(report.Networks, doctorNetwork{Name: deps.Config.Network, Verdict: "unreachable", Message: err.Error()})
			}
			if !slices.ContainsFunc(networks, func(n rpc.Network) bool { return n.Name == "testnet" }) {
				networks = append(networks, rpc.Network{Name: "testnet", Passphrase: testnetPassphrase, RPCURL: rpc.DefaultTestnetURL})
			}
			for _, n := range networks {
				report.Networks = append(report.Networks, checkNetworkLane(ctx, deps, n, lanes, report.Simulator != nil))
			}

			report.Tools = doctorTools(ctx, deps)
			report.Cache = doctorCacheOf(deps)

			if err := printer.Result(report, func(w io.Writer) error { return writeDoctor(w, report) }); err != nil {
				return err
			}
			if report.Simulator == nil {
				return fmt.Errorf("%w: %s", exitcode.ErrConfiguration, report.SimulatorError)
			}
			for _, n := range report.Networks {
				if n.Verdict != "ok" && n.Verdict != "unreachable" {
					return fmt.Errorf("%w: %s", exitcode.ErrHostUnsupported, n.Message)
				}
			}
			return nil
		},
	}
	cmd.Flags().String("rpc-url", "", "the RPC to read the selected network's protocol from")
	cmd.Flags().String("network-passphrase", "", "passphrase of a custom --network")
	return cmd
}

const testnetPassphrase = "Test SDF Network ; September 2015"

func checkNetworkLane(ctx context.Context, deps Deps, n rpc.Network, lanes []int, haveSim bool) doctorNetwork {
	out := doctorNetwork{Name: n.Name, RPCURL: n.RPCURL}
	latest, err := rpc.New(n.RPCURL, deps.RPCOptions...).GetLatestLedger(ctx)
	if err != nil {
		out.Verdict = "unreachable"
		out.Message = fmt.Sprintf("%s's RPC did not answer: %v", n.Name, err)
		return out
	}
	p := latest.ProtocolVersion
	out.Protocol = &p
	switch {
	case !haveSim:
		out.Verdict = "unreachable"
		out.Message = "no simulator to check against"
	case slices.Contains(lanes, p):
		out.Verdict = "ok"
	case len(lanes) > 0 && p > slices.Max(lanes):
		out.Verdict = "ahead"
	case len(lanes) > 0 && p < slices.Min(lanes):
		out.Verdict = "behind"
	default:
		out.Verdict = "gap"
	}
	if out.Verdict != "ok" && haveSim {
		out.Message = laneMismatch(n.Name, p, lanes)
	}
	return out
}

func doctorTools(ctx context.Context, deps Deps) []doctorTool {
	stellar := deps.KeysBinary
	if stellar == "" {
		stellar = keys.DefaultBinary
	}
	version := func(name, bin string, args ...string) doctorTool {
		out, err := runTool(ctx, bin, args...)
		if err != nil {
			var missing *exec.Error
			if errors.As(err, &missing) || errors.Is(err, fs.ErrNotExist) {
				return doctorTool{Name: name, Status: "missing"}
			}
			return doctorTool{Name: name, Status: "missing", Note: err.Error()}
		}
		return doctorTool{Name: name, Status: "ok", Version: strings.SplitN(out, "\n", 2)[0]}
	}
	tools := []doctorTool{version("stellar", stellar, "--version"), version("cargo", "cargo", "--version")}
	docker := doctorTool{Name: "docker", Note: "for --localnet"}
	if _, err := runTool(ctx, "docker", "--version"); err != nil {
		docker.Status = "missing"
	} else if v, err := runTool(ctx, "docker", "info", "--format", "{{.ServerVersion}}"); err != nil {
		docker.Status = "not running"
	} else {
		docker.Status, docker.Version = "ok", v
	}
	return append(tools, docker)
}

func doctorCacheOf(deps Deps) doctorCache {
	root, err := deps.ForkRoot()
	if err != nil {
		return doctorCache{}
	}
	c := doctorCache{Path: tildePath(root)}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if d.Name() == "manifest.json" {
			c.Forks++
		}
		if info, err := d.Info(); err == nil {
			c.Bytes += info.Size()
		}
		return nil
	})
	return c
}

func writeDoctor(w io.Writer, r doctorReport) error {
	var b strings.Builder
	fmt.Fprintf(&b, "signet %s\n", r.CLI.Version)
	if r.Simulator != nil {
		fmt.Fprintf(&b, "signet-simulator %s (%s)\n", r.Simulator.Version, r.Simulator.Commit)
		for _, l := range r.Simulator.Lanes {
			fmt.Fprintf(&b, "  lane p%d  soroban-env-host %s, soroban-simulation %s\n", l.Protocol, l.EnvHost, l.Simulation)
		}
	} else {
		fmt.Fprintf(&b, "signet-simulator: %s\n", r.SimulatorError)
	}
	b.WriteString("networks\n")
	for _, n := range r.Networks {
		protocol := "?"
		if n.Protocol != nil {
			protocol = fmt.Sprint(*n.Protocol)
		}
		fmt.Fprintf(&b, "  %-9s protocol %-3s %s\n", n.Name, protocol, n.Verdict)
		if n.Message != "" {
			fmt.Fprintf(&b, "            %s\n", n.Message)
		}
	}
	b.WriteString("tools\n")
	for _, t := range r.Tools {
		line := t.Status
		if t.Version != "" {
			line = t.Version
		}
		if t.Note != "" {
			line += " (" + t.Note + ")"
		}
		fmt.Fprintf(&b, "  %-9s %s\n", t.Name, line)
	}
	if r.Cache.Path != "" {
		fmt.Fprintf(&b, "fork cache %s: %d fork%s, %s\n", r.Cache.Path, r.Cache.Forks, map[bool]string{true: "", false: "s"}[r.Cache.Forks == 1], humanBytes(r.Cache.Bytes))
	}
	_, err := io.WriteString(w, b.String())
	return err
}
