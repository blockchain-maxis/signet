package cmd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/browser"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
	"github.com/blockchain-maxis/signet/cli/internal/visualise"
)

func init() {
	register(groupContracts, newVisualiseCmd)
}

// newVisualiseCmd is `signet visualise <address>` (#578): a contract's
// diagram as an SVG file, drawn by the same visualiser as the web app, run
// in-process.
func newVisualiseCmd() *cobra.Command {
	var (
		wasmPath, network, out, theme string
		open                          bool
	)
	cmd := &cobra.Command{
		Use:   "visualise <address>",
		Short: "Draw a contract's diagram as an SVG file",
		Long: `Draw a contract's diagram as an SVG file, with the visualiser the web app
uses, run inside signet: no browser and no Signet server.

The WASM comes from --wasm, or from the network through
"stellar contract fetch"; signet-simulator reads its spec. A contract too
simple or too large for a diagram still gets an SVG, the function list, and
the reason is printed. A WASM without a spec exits 14.

--open opens the diagram in a running "signet dev --ui" session for the
contract instead, or says how to start one.`,
		Example: `  signet visualise CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
  signet visualise CASF…RCN --wasm target/wasm32v1-none/release/registry.wasm --theme dark --out registry.svg`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			address := args[0]
			if err := requireContract(address); err != nil {
				return err
			}
			switch theme {
			case "dark", "light", "auto":
			default:
				return &inputError{"--theme must be dark, light or auto"}
			}
			if network != "testnet" && network != "mainnet" {
				return &inputError{"--network must be testnet or mainnet"}
			}
			printer := printerFor(cmd)
			if open {
				return openInDevUI(cmd, address)
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()

			wasm, err := readOrFetchWasm(ctx, deps, address, network, wasmPath)
			if err != nil {
				return err
			}
			sim, err := startSimulator(ctx, deps, printer.Progress)
			if err != nil {
				return err
			}
			var extracted simulator.SpecExtractResult
			_, err = callSimulator(ctx, sim, simulator.TypeSpecExtract, simulator.SpecExtractParams{
				Source: simulator.Source{WasmBase64: base64.StdEncoding.EncodeToString(wasm)},
			}, &extracted)
			_ = sim.Close()
			if err != nil {
				return err
			}
			if len(extracted.SpecEntriesXDR) == 0 {
				return fmt.Errorf("%w: %s's WASM carries no contractspecv0 section, so there is no interface to draw", exitcode.ErrNoSpec, shorten(address, 4, 3))
			}
			result, err := visualise.Render(visualise.Input{SpecJSON: extracted.Spec, Theme: theme, Address: address, Network: network})
			if err != nil {
				if errors.Is(err, visualise.ErrTimeout) {
					return fmt.Errorf("%w: %v", exitcode.ErrTimeout, err)
				}
				return err
			}
			if out == "" {
				out = shorten(address, 4, 3) + ".svg"
				out = strings.ReplaceAll(out, "…", "-")
			}
			// A text file ends with a newline, as the visualiser's goldens do.
			if err := os.WriteFile(out, []byte(result.SVG+"\n"), 0o644); err != nil {
				return fmt.Errorf("%w: %v", exitcode.ErrConfiguration, err)
			}
			if result.Decision.Kind != "draw" {
				reason, _ := result.Decision.Rest["reason"].(string)
				printer.Progress(fmt.Sprintf("%s: drew the function list instead of a diagram. %s", result.Decision.Kind, reason))
			}
			return printer.Result(struct {
				Path     string             `json:"path"`
				Decision visualise.Decision `json:"decision"`
				WasmHash string             `json:"wasmHash"`
			}{out, result.Decision, result.WasmHash}, func(w io.Writer) error {
				_, err := fmt.Fprintf(w, "Wrote %s (%s)\n", out, result.Decision.Kind)
				return err
			})
		},
	}
	cmd.Flags().StringVar(&wasmPath, "wasm", "", "read the WASM from this file instead of fetching it")
	cmd.Flags().StringVar(&network, "network", "testnet", "the network to fetch the WASM from: testnet or mainnet")
	cmd.Flags().StringVar(&out, "out", "", "the SVG to write (default <address-short>.svg)")
	cmd.Flags().StringVar(&theme, "theme", "auto", "dark, light, or auto (follows the viewer's colour scheme)")
	cmd.Flags().BoolVar(&open, "open", false, "open the diagram in a running signet dev --ui session for this contract")
	return cmd
}

// readOrFetchWasm reads --wasm, or fetches the contract's WASM with the
// stellar CLI.
func readOrFetchWasm(ctx context.Context, deps Deps, address, network, path string) ([]byte, error) {
	if path != "" {
		wasm, err := os.ReadFile(path)
		if err != nil {
			return nil, &inputError{fmt.Sprintf("--wasm: %v", err)}
		}
		return wasm, nil
	}
	binary := deps.KeysBinary
	if binary == "" {
		binary = keys.DefaultBinary
	}
	if err := keys.CheckStellarCLI(binary); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "signet-visualise")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	target := filepath.Join(dir, "contract.wasm")
	fetch := exec.CommandContext(ctx, binary, "contract", "fetch", "--id", address, "--network", network, "-o", target)
	if output, err := fetch.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("%w: stellar contract fetch %s: %v\n%s", exitcode.ErrNetwork, shorten(address, 4, 3), err, strings.TrimSpace(string(output)))
	}
	return os.ReadFile(target)
}

// uiRegistration is how a running signet dev --ui session is found: its
// URL (token included) by contract, in a 0600 file in the user's cache
// directory, removed when the session ends.
type uiRegistration struct {
	URL      string `json:"url"`
	Contract string `json:"contract"`
}

func uiRegistrationPath(contract string) (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "signet", "ui", contract+".json"), nil
}

// registerUI records a running UI for visualise --open; the returned
// function removes it.
func registerUI(contract, url string) func() {
	path, err := uiRegistrationPath(contract)
	if err != nil {
		return func() {}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return func() {}
	}
	raw, _ := json.Marshal(uiRegistration{URL: url, Contract: contract})
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return func() {}
	}
	return func() { _ = os.Remove(path) }
}

// openInDevUI opens the Diagram view of a running signet dev --ui session
// for the contract, if one answers.
func openInDevUI(cmd *cobra.Command, contract string) error {
	hint := fmt.Sprintf("no signet dev --ui session is running for %s: start one with\n  signet dev %s --ui", shorten(contract, 4, 3), contract)
	path, err := uiRegistrationPath(contract)
	if err != nil {
		return &inputError{hint}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return &inputError{hint}
	}
	var reg uiRegistration
	if json.Unmarshal(raw, &reg) != nil {
		return &inputError{hint}
	}
	base, token, ok := strings.Cut(reg.URL, "#t=")
	if !ok {
		return &inputError{hint}
	}
	probe, _ := http.NewRequestWithContext(cmd.Context(), http.MethodGet, strings.TrimSuffix(base, "/")+"/api/health", nil)
	probe.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(probe)
	if err != nil {
		_ = os.Remove(path) // the session is gone
		return &inputError{hint}
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &inputError{hint}
	}
	return browser.OpenOrPrint(cmd.OutOrStdout(), reg.URL+"&view=diagram", false)
}
