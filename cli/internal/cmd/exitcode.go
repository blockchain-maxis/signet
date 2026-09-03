package cmd

import (
	"errors"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// ExitCoder is implemented by an error that knows which process exit code it
// should map to. link.ValidationError is the first (and, so far, only) one —
// distinct from exitcode's sentinel-error taxonomy, which is for failure
// classes shared across packages rather than one type's own opinion.
type ExitCoder interface {
	ExitCode() int
}

// ExitCode maps err to the process exit code main() should use:
//  1. exitcode.CodeFor's sentinel taxonomy (configuration, no identity,
//     signing failure, network, timeout, approval rejected, already-linked) —
//     checked via errors.Is, so it matches regardless of how many times the
//     error was wrapped with %w on its way up.
//  2. The ExitCoder interface, for a type with its own specific code
//     (link.ValidationError → exitcode.InvalidInput).
//  3. exitcode.Generic — main() must always be able to report *some*
//     failure, even for an error type neither mechanism recognizes.
func ExitCode(err error) int {
	if err == nil {
		return exitcode.OK
	}
	if code, ok := exitcode.CodeFor(err); ok {
		return code
	}
	var coder ExitCoder
	if errors.As(err, &coder) {
		return coder.ExitCode()
	}
	return exitcode.Generic
}
