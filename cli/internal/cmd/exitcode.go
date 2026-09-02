package cmd

import (
	"errors"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// ExitCoder is implemented by an error that knows which process exit code it
// should map to. link.ValidationError is the first (and, so far, only) one.
type ExitCoder interface {
	ExitCode() int
}

// ExitCode maps err to the process exit code main() should use. An error
// that doesn't opt into a specific code via ExitCoder maps to
// exitcode.Generic — main() must always be able to report *some* failure,
// even for an error type this package doesn't specifically recognize.
func ExitCode(err error) int {
	if err == nil {
		return exitcode.OK
	}
	var coder ExitCoder
	if errors.As(err, &coder) {
		return coder.ExitCode()
	}
	return exitcode.Generic
}
