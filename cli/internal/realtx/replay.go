package realtx

import (
	"fmt"
	"slices"

	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// Params are a real transaction as a replay (#636): its host function and
// source account against the fork's current state, with recording-mode
// auth, since its signatures' nonces are already spent on the fork.
func (t Tx) Params() simulator.SimulateParams {
	return simulator.SimulateParams{
		Function:      t.Function(),
		ArgsXDR:       t.ArgsXDR(),
		SourceAccount: t.Decoded.SourceAccount,
		AuthMode:      "record",
	}
}

// Label is how a replay of t is shown: tx 3f2a… (ledger 4851010, claim).
func (t Tx) Label() string {
	return fmt.Sprintf("tx %s (ledger %d, %s)", t.Hash[:min(4, len(t.Hash))]+"…", t.Ledger, t.Function())
}

// Link is the transaction on stellar.expert, for testnet and mainnet.
func Link(network, hash string) string {
	switch network {
	case "mainnet":
		return "https://stellar.expert/explorer/public/tx/" + hash
	case "testnet":
		return "https://stellar.expert/explorer/testnet/tx/" + hash
	}
	return ""
}

// Fidelity says whether the local deployed-code run (A) behaved as the
// chain did. A replay runs against the fork's current state, not the state
// at the transaction's ledger, so only a high-fidelity replay's A/B diff
// says something about the change; a low-fidelity one is shown, but does
// not fail --ci unless fail_on_low_fidelity.
type Fidelity struct {
	High   bool   `json:"high"`
	Reason string `json:"reason,omitempty"`
}

// CheckFidelity compares A's outcome with the on-chain return value and
// contract events, exactly (XDR against XDR); a transaction that failed
// on-chain is high-fidelity when A fails too.
func CheckFidelity(t Tx, aResult *simulator.SimulateResult, aErr *simulator.ContractError) Fidelity {
	low := func(what string) Fidelity {
		return Fidelity{Reason: fmt.Sprintf("low-fidelity (state changed since ledger %d): %s", t.Ledger, what)}
	}
	if t.Failed {
		if aErr != nil {
			return Fidelity{High: true}
		}
		return low("the deployed code succeeds here now, where it failed on-chain")
	}
	if aErr != nil || aResult == nil {
		code := "no result"
		if aErr != nil {
			code = aErr.Code
		}
		return low(fmt.Sprintf("the deployed code fails here now (%s), where it succeeded on-chain", code))
	}
	onChain := t.Decoded.Result
	if onChain == nil {
		return low("the transaction's meta carries no result to compare with")
	}
	if onChain.ReturnValue == nil || onChain.ReturnValue.XDR != aResult.ReturnValueXDR {
		return low("it returns something else now")
	}
	var chainEvents, localEvents []string
	for _, e := range onChain.Events {
		if e.Type == "contract" {
			chainEvents = append(chainEvents, e.EventXDR)
		}
	}
	for _, e := range aResult.Events {
		if e.Type == "contract" {
			localEvents = append(localEvents, e.EventXDR)
		}
	}
	if !slices.Equal(chainEvents, localEvents) {
		return low(fmt.Sprintf("it emits other events now (%d on-chain, %d here)", len(chainEvents), len(localEvents)))
	}
	return Fidelity{High: true}
}
