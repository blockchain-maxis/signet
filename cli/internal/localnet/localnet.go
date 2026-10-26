// Package localnet is `signet dev --localnet` (#588, #589, #590): a Stellar
// Quickstart local network next to the fork, with the current build deployed
// to it, so a frontend or a wallet has a real RPC that accepts real signed
// transactions.
//
// It is additive: the fork keeps running exactly as before. Everything here
// goes through the `stellar` CLI (and `docker`, only to say clearly when it
// is missing): `stellar container start local` runs Quickstart, `stellar keys`
// makes and funds the identities, and `stellar contract` deploys, upgrades,
// invokes and writes bindings. Nothing is sent anywhere but localhost.
package localnet

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const (
	// DefaultRPCURL is where Quickstart serves Soroban RPC.
	DefaultRPCURL = "http://localhost:8000/rpc"
	// Passphrase is the standalone network's.
	Passphrase = "Standalone Network ; February 2017"
	// Network is the `stellar` CLI's name for it.
	Network = "local"
	// Identity is the deployer: it deploys, upgrades and is the admin.
	Identity = "signet-dev"
	// StateFile is written after every deploy, for frontends to watch.
	StateFile = "localnet.json"
)

var (
	contractRE = regexp.MustCompile(`^C[A-Z2-7]{55}$`)
	accountRE  = regexp.MustCompile(`^G[A-Z2-7]{55}$`)
	hashRE     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Probe asks an RPC endpoint for its network passphrase.
type Probe func(ctx context.Context, rpcURL string) (passphrase string, healthy bool, err error)

// Options configures the local network.
type Options struct {
	// Stellar and Docker are the binaries; empty means "stellar" and "docker".
	Stellar, Docker string
	// RPCURL defaults to DefaultRPCURL.
	RPCURL string
	// Protocol is the fork's ledger protocol, which a new network starts at.
	Protocol int
	// Limits is passed to `stellar container start --limits` when set.
	Limits string
	// Probe defaults to JSON-RPC getNetwork and getHealth.
	Probe Probe
	// Wait is how long a new network has to become healthy (default 3m);
	// Poll how often it is asked (default 2s).
	Wait, Poll time.Duration
	// Progress gets one line per step.
	Progress func(string)
}

func (o *Options) defaults() {
	if o.Stellar == "" {
		o.Stellar = "stellar"
	}
	if o.Docker == "" {
		o.Docker = "docker"
	}
	if o.RPCURL == "" {
		o.RPCURL = DefaultRPCURL
	}
	if o.Probe == nil {
		o.Probe = RPCProbe
	}
	if o.Wait == 0 {
		o.Wait = 3 * time.Minute
	}
	if o.Poll == 0 {
		o.Poll = 2 * time.Second
	}
	if o.Progress == nil {
		o.Progress = func(string) {}
	}
}

// Net is a running local network.
type Net struct {
	o Options
	// Started is false when a network was already running.
	Started bool
	// Deployer is Identity's address.
	Deployer string
}

// Start finds a local network already running at the RPC URL, or starts
// one with `stellar container start local`, waits for it, and makes and
// funds the deployer identity.
func Start(ctx context.Context, o Options) (*Net, error) {
	o.defaults()
	n := &Net{o: o}
	passphrase, _, err := o.Probe(ctx, o.RPCURL)
	switch {
	case err == nil && passphrase == Passphrase:
		o.Progress("localnet: using the network already running at " + o.RPCURL)
	case err == nil:
		return nil, configError("something at %s answers as a Stellar RPC for %q, not the local network; stop it, or it cannot be the localnet", o.RPCURL, passphrase)
	default:
		if err := n.checkDocker(ctx); err != nil {
			return nil, err
		}
		if err := checkPortFree(o.RPCURL); err != nil {
			return nil, err
		}
		args := []string{"container", "start", Network, "--protocol-version", strconv.Itoa(o.Protocol)}
		if o.Limits != "" {
			args = append(args, "--limits", o.Limits)
		}
		o.Progress(fmt.Sprintf("localnet: starting Quickstart at protocol %d (stellar %s)", o.Protocol, strings.Join(args, " ")))
		if _, err := n.stellar(ctx, args...); err != nil {
			return nil, err
		}
		if err := n.waitHealthy(ctx); err != nil {
			return nil, err
		}
		n.Started = true
	}
	addr, err := n.Fund(ctx, Identity)
	if err != nil {
		return nil, err
	}
	n.Deployer = addr
	return n, nil
}

func configError(format string, args ...any) error {
	return fmt.Errorf("%w: %s", exitcode.ErrConfiguration, fmt.Sprintf(format, args...))
}

// checkDocker says plainly when Docker is missing or not running: Quickstart
// is a container.
func (n *Net) checkDocker(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, n.o.Docker, "info", "--format", "{{.ServerVersion}}")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return configError("--localnet runs Stellar Quickstart in Docker, and docker is not installed (https://docs.docker.com/get-docker/)")
		}
		detail := firstLine(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return configError("--localnet needs Docker running, and it is not: %s. Start Docker (Docker Desktop, or the docker service) and run again", detail)
	}
	return nil
}

// checkPortFree fails when something that is not an RPC holds the port.
func checkPortFree(rpcURL string) error {
	u, err := url.Parse(rpcURL)
	if err != nil {
		return configError("--localnet RPC URL %q: %v", rpcURL, err)
	}
	port := u.Port()
	if port == "" {
		port = "80"
	}
	l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		return configError("port %s is in use by something that is not a Stellar RPC, so Quickstart cannot start there; stop what holds it (a container from an earlier run: `stellar container stop local`)", port)
	}
	_ = l.Close()
	return nil
}

func (n *Net) waitHealthy(ctx context.Context) error {
	deadline := time.Now().Add(n.o.Wait)
	for {
		passphrase, healthy, err := n.o.Probe(ctx, n.o.RPCURL)
		if err == nil && healthy && passphrase == Passphrase {
			n.o.Progress("localnet: healthy at " + n.o.RPCURL)
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%w: the local network did not become healthy within %s (stellar container logs local shows why)", exitcode.ErrTimeout, n.o.Wait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(n.o.Poll):
		}
	}
}

// RPCProbe asks getNetwork for the passphrase and getHealth for the status.
func RPCProbe(ctx context.Context, rpcURL string) (string, bool, error) {
	call := func(method string, out any) error {
		body := strings.NewReader(fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":%q}`, method))
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, rpcURL, body)
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			return err
		}
		defer func() { _ = res.Body.Close() }()
		raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		if err != nil {
			return err
		}
		var envelope struct {
			Result json.RawMessage `json:"result"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Result == nil {
			return fmt.Errorf("%s did not answer %s as a Stellar RPC", rpcURL, method)
		}
		return json.Unmarshal(envelope.Result, out)
	}
	var network struct {
		Passphrase string `json:"passphrase"`
	}
	if err := call("getNetwork", &network); err != nil {
		return "", false, err
	}
	var health struct {
		Status string `json:"status"`
	}
	healthy := call("getHealth", &health) == nil && health.Status == "healthy"
	return network.Passphrase, healthy, nil
}

// stellar runs the stellar CLI and returns its stdout.
func (n *Net) stellar(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, n.o.Stellar, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("%w: stellar %s: %s", exitcode.ErrNetwork, strings.Join(args[:min(3, len(args))], " "), lastLines(detail, 3))
	}
	return stdout.String(), nil
}

// Fund makes an identity (or reuses one) and funds it on the local network,
// which starts from genesis, so an identity funded before is not funded
// here. It returns the identity's address.
func (n *Net) Fund(ctx context.Context, name string) (string, error) {
	if _, err := n.stellar(ctx, "keys", "address", name); err != nil {
		if _, err := n.stellar(ctx, "keys", "generate", name, "--fund", "--network", Network); err != nil {
			return "", err
		}
	} else if _, err := n.stellar(ctx, "keys", "fund", name, "--network", Network); err != nil {
		return "", err
	}
	out, err := n.stellar(ctx, "keys", "address", name)
	if err != nil {
		return "", err
	}
	addr := lastLine(out)
	if !accountRE.MatchString(addr) {
		return "", fmt.Errorf("%w: stellar keys address %s printed %q, not an account", exitcode.ErrNetwork, name, addr)
	}
	return addr, nil
}

// Deploy deploys a WASM as the deployer, with constructor arguments after
// `--` when there are any, and returns the new contract's address.
func (n *Net) Deploy(ctx context.Context, wasm string, constructor []string) (string, error) {
	args := []string{"contract", "deploy", "--wasm", wasm, "--source", Identity, "--network", Network}
	if len(constructor) > 0 {
		args = append(append(args, "--"), constructor...)
	}
	out, err := n.stellar(ctx, args...)
	if err != nil {
		return "", err
	}
	id := lastLine(out)
	if !contractRE.MatchString(id) {
		return "", fmt.Errorf("%w: stellar contract deploy printed %q, not a contract address", exitcode.ErrNetwork, id)
	}
	return id, nil
}

// Upload installs a WASM and returns its hash.
func (n *Net) Upload(ctx context.Context, wasm string) (string, error) {
	out, err := n.stellar(ctx, "contract", "upload", "--wasm", wasm, "--source", Identity, "--network", Network)
	if err != nil {
		return "", err
	}
	hash := strings.ToLower(lastLine(out))
	if !hashRE.MatchString(hash) {
		return "", fmt.Errorf("%w: stellar contract upload printed %q, not a WASM hash", exitcode.ErrNetwork, hash)
	}
	return hash, nil
}

// Invoke sends a real transaction calling fn on the contract.
func (n *Net) Invoke(ctx context.Context, contract, source, fn string, args []string) (string, error) {
	all := append([]string{"contract", "invoke", "--id", contract, "--source", source, "--network", Network, "--send", "yes", "--", fn}, args...)
	return n.stellar(ctx, all...)
}

// Bindings writes TypeScript bindings for the contract into dir.
func (n *Net) Bindings(ctx context.Context, wasm, contract, dir string) error {
	_, err := n.stellar(ctx, "contract", "bindings", "typescript", "--wasm", wasm, "--contract-id", contract,
		"--network", Network, "--output-dir", dir, "--overwrite")
	return err
}

// RPCURL is where the network answers.
func (n *Net) RPCURL() string { return n.o.RPCURL }

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " / ")
}

// WasmHash is a WASM file's SHA-256, the hash the network names it by.
func WasmHash(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// State is localnet.json.
type State struct {
	ContractID        string `json:"contractId"`
	RPCURL            string `json:"rpcUrl"`
	NetworkPassphrase string `json:"networkPassphrase"`
	WasmHash          string `json:"wasmHash"`
	DeployedAt        string `json:"deployedAt"`
	// SeedAccounts maps a fork account a seed call named to the funded
	// localnet identity that stood in for it (#590).
	SeedAccounts map[string]SeedAccount `json:"seedAccounts,omitempty"`
}

// SeedAccount is a localnet identity standing in for a fork account.
type SeedAccount struct {
	Identity string `json:"identity"`
	Address  string `json:"address"`
}

// WriteState writes dir/localnet.json atomically: a temporary file in the
// same directory, then a rename, so a watcher never reads half a file.
func WriteState(dir string, s State) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, StateFile+".*.tmp")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(append(raw, '\n'))
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmp.Name())
		return errors.Join(werr, cerr)
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, StateFile)); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}

// sortedKeys is m's keys, sorted, so arguments are passed deterministically.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
