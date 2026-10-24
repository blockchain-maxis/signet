package simulator

import (
	"fmt"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// The exact wording docs/CLI_RUST_BRIDGE.md §2 fixes for a failed handshake.
const (
	msgCannotStart = "could not start the contract simulator — reinstall signet-cli."
	msgMismatch    = "simulator protocol version mismatch: CLI expects %d, found binary reporting %d — reinstall signet-cli so both binaries come from the same release."
)

// StartError is a handshake that did not produce a usable simulator: a
// protocol version mismatch, or anything else before a valid hello_ack. Its
// message is the note's exact text.
type StartError struct {
	// Mismatch is true when the binary answered with a different protocol
	// version; Server is the version it reported.
	Mismatch bool
	Server   int
	// Cause is what went wrong underneath (an early exit, a non-JSON line),
	// kept for debugging but not part of the message.
	Cause  error
	Stderr []string
}

func (e *StartError) Error() string {
	if e.Mismatch {
		return fmt.Sprintf(msgMismatch, ProtocolVersion, e.Server)
	}
	return msgCannotStart
}

func (e *StartError) Unwrap() []error {
	if e.Cause != nil {
		return []error{exitcode.ErrSimulator, e.Cause}
	}
	return []error{exitcode.ErrSimulator}
}

// Error is a simulator failure: an `error` response, a dead pipe, a non-zero
// exit or a line that is not JSON. It is never a contract that said no
// (that is a *ContractError value) and never a timeout.
type Error struct {
	// Code and Detail are set when the simulator answered with an `error`
	// line; Code is empty when Go inferred the failure itself.
	Code    string
	Message string
	Detail  map[string]any
	// Stderr is the last lines the process wrote to stderr (at most
	// stderrTailLines), oldest first.
	Stderr []string
}

func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString("simulator error")
	if e.Code != "" {
		b.WriteString(" (" + e.Code + ")")
	}
	b.WriteString(": " + e.Message)
	if len(e.Stderr) > 0 {
		b.WriteString("\nsimulator stderr (last lines):\n  ")
		b.WriteString(strings.Join(e.Stderr, "\n  "))
	}
	return b.String()
}

func (e *Error) Unwrap() error { return exitcode.ErrSimulator }

// TimeoutError is a request that ran past its deadline. The process was
// killed; the next Call starts a fresh one.
type TimeoutError struct {
	Type    string
	Timeout time.Duration
}

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("simulator %s did not answer within %s and was stopped — the call may be looping (raise --timeout or SIGNET_SIMULATOR_TIMEOUT if it is just slow)", e.Type, e.Timeout)
}

func (e *TimeoutError) Unwrap() error { return exitcode.ErrTimeout }
