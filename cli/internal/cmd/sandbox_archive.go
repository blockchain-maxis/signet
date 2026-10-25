package cmd

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/fork"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/rpc"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// archiveFork forks a contract from a history-archive snapshot (#554): every
// entry of the contract at one checkpoint ledger, consistent, where a lazy
// fork holds only what something read and can mix ledgers (#551).
//
// `stellar snapshot create` does the archive work and writes soroban's
// LedgerSnapshot JSON; the simulator reads it (snapshot_read) into the RPC
// form the fork cache holds, so Go parses no XDR. It is slow (the archive's
// buckets are streamed), so it is opt-in; a failed run is retried once.
// Anything outside the contract a later call reads (another contract, an
// account) is still fetched lazily from RPC.
func archiveFork(ctx context.Context, deps Deps, network rpc.Network, contract string, ledger uint32, progress func(string)) (fork.Manifest, error) {
	binary := deps.KeysBinary
	if binary == "" {
		binary = keys.DefaultBinary
	}
	if err := keys.CheckStellarCLI(binary); err != nil {
		return fork.Manifest{}, err
	}
	tmp, err := os.MkdirTemp("", "signet-snapshot")
	if err != nil {
		return fork.Manifest{}, fmt.Errorf("%w: %v", exitcode.ErrConfiguration, err)
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	out := filepath.Join(tmp, "snapshot.json")

	args := []string{"snapshot", "create", "--address", contract, "--output", "json", "--out", out,
		"--network-passphrase", network.Passphrase}
	if network.RPCURL != "" {
		args = append(args, "--rpc-url", network.RPCURL)
	}
	if ledger > 0 {
		args = append(args, "--ledger", strconv.FormatUint(uint64(ledger), 10))
	}
	progress(fmt.Sprintf("Snapshotting %s from the %s history archive with `stellar snapshot create`; this takes minutes.",
		shorten(contract, 4, 3), network.Name))
	var failure string
	for attempt := 1; attempt <= 2; attempt++ {
		if failure, err = runStellar(ctx, binary, args, progress); err == nil {
			break
		}
		if ctx.Err() != nil {
			return fork.Manifest{}, ctx.Err()
		}
		if attempt == 1 {
			progress("stellar snapshot create failed (" + failure + "); trying once more.")
		}
	}
	if err != nil {
		return fork.Manifest{}, fmt.Errorf("%w: stellar snapshot create failed twice: %s\nThe default lazy fork needs no history archive: run without --archive",
			exitcode.ErrNetwork, failure)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		return fork.Manifest{}, fmt.Errorf("%w: stellar snapshot create wrote no snapshot: %v", exitcode.ErrNetwork, err)
	}

	sim, err := startSimulator(ctx, deps, progress)
	if err != nil {
		return fork.Manifest{}, err
	}
	defer func() { _ = sim.Close() }()
	var snap simulator.SnapshotReadResult
	if _, err := callSimulator(ctx, sim, simulator.TypeSnapshotRead, simulator.SnapshotReadParams{SnapshotJSON: string(raw)}, &snap); err != nil {
		return fork.Manifest{}, err
	}
	sum := sha256.Sum256([]byte(network.Passphrase))
	if snap.NetworkID != hex.EncodeToString(sum[:]) {
		return fork.Manifest{}, fmt.Errorf("%w: the snapshot is of another network than %s", exitcode.ErrNetwork, network.Name)
	}
	if err := checkLanes(network.Name, snap.ProtocolVersion, sim.HelloAck()); err != nil {
		return fork.Manifest{}, err
	}

	rootDir := deps.ForkRoot
	if rootDir == nil {
		rootDir = fork.Root
	}
	root, err := rootDir()
	if err != nil {
		return fork.Manifest{}, err
	}
	m := fork.Manifest{
		Network:    network.Name,
		Passphrase: network.Passphrase,
		RPCURL:     network.RPCURL,
		Contract:   contract,
		ForkLedger: snap.SequenceNumber,
		ForkTime:   time.Unix(int64(snap.Timestamp), 0).UTC(),
		Protocol:   snap.ProtocolVersion,
		Lanes:      []int{snap.ProtocolVersion},
		Consistent: true,
	}
	cache, err := fork.Create(root, m)
	if err != nil {
		return fork.Manifest{}, err
	}
	saved := false
	defer func() {
		_ = cache.Close()
		if !saved {
			_ = os.RemoveAll(cache.Dir())
		}
	}()
	entries := make([]fork.Entry, 0, len(snap.Entries))
	for _, e := range snap.Entries {
		entries = append(entries, fork.Entry{
			Key: e.KeyXDR, XDR: e.DataXDR, ExtXDR: e.ExtXDR,
			LastModifiedLedgerSeq: e.LastModifiedLedgerSeq, LiveUntilLedgerSeq: e.LiveUntilLedger,
			FetchedAtLedger: snap.SequenceNumber,
		})
	}
	if err := cache.PutEntries(entries); err != nil {
		return fork.Manifest{}, err
	}

	// What the snapshot does not hold comes from RPC, as on a lazy fork.
	var source fork.EntrySource = noRPC{}
	if network.RPCURL != "" {
		if client, _, err := rpc.Connect(ctx, network, deps.RPCOptions...); err == nil {
			source = client
		}
	}
	fetcher := &fork.Fetcher{Ctx: ctx, Cache: cache, RPC: source, ForkLedger: snap.SequenceNumber}
	sim.HandleFetch(fetcher.Fetch)
	protocol, sequence, timestamp := snap.ProtocolVersion, snap.SequenceNumber, snap.Timestamp
	if _, err := callSimulator(ctx, sim, simulator.TypeLedgerOpen, simulator.LedgerOpenParams{
		NetworkPassphrase: network.Passphrase, LedgerProtocol: &protocol, Sequence: &sequence, Timestamp: &timestamp,
	}, nil); err != nil {
		return fork.Manifest{}, err
	}
	var info simulator.ContractInfoResult
	if _, err := callSimulator(ctx, sim, simulator.TypeContractInfo, simulator.ContractInfoParams{ContractID: contract}, &info); err != nil {
		var se *simulator.Error
		if errors.As(err, &se) && se.Code == "bad_request" && se.Detail["path"] == "contract_id" {
			return fork.Manifest{}, &inputError{fmt.Sprintf("the snapshot holds no contract %s: %s", contract, se.Message)}
		}
		return fork.Manifest{}, err
	}
	m.Executable = info.Executable
	if info.WasmHash != nil {
		m.WasmHash = *info.WasmHash
	}
	m.InstanceStorageEntries = info.StorageEntries
	if err := cache.SaveManifest(m); err != nil {
		return fork.Manifest{}, err
	}
	saved = true
	progress(fmt.Sprintf("Imported %d entries at ledger %d.", len(entries), snap.SequenceNumber))
	return m, nil
}

// runStellar runs the stellar CLI, relaying what it says on stderr as
// progress, and returns its last line when it fails.
func runStellar(ctx context.Context, binary string, args []string, progress func(string)) (string, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err.Error(), err
	}
	if err := cmd.Start(); err != nil {
		return err.Error(), err
	}
	last := ""
	scanner := bufio.NewScanner(stderr)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		last = line
		progress("  stellar: " + line)
	}
	if err := cmd.Wait(); err != nil {
		if last == "" {
			last = err.Error()
		}
		return last, err
	}
	return "", nil
}

// noRPC answers no fetch: an archive fork with no RPC to fall back on.
type noRPC struct{}

func (noRPC) GetLedgerEntries(context.Context, []string) (rpc.LedgerEntries, error) {
	return rpc.LedgerEntries{}, fmt.Errorf("%w: no RPC to fetch what the snapshot does not hold", exitcode.ErrNetwork)
}
