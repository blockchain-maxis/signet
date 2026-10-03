package spec

import "github.com/blockchain-maxis/signet/cli/internal/exitcode"

// failureErrors maps every failure code a CLI route can put in an error body
// to the exit-code sentinel it produces. It is keyed by CliFailureCode, the
// union of every route's failures, because a code means the same thing on
// every route that uses it — one table, not one per route.
//
// This is the reason codes exist: the CLI used to tell failures apart by
// matching English message text, so rewording a message silently changed an
// exit code. errors_test.go fails if a generated code is missing here.
//
// Most refusals are ErrNetwork — "the deployment answered, and not with what
// we needed" — which is what they were before codes existed. The exceptions
// are the ones a script needs to tell apart.
var failureErrors = map[CliFailureCode]error{
	// The deployment cannot do this at all: no database for pairing, or no
	// signing key for challenges. The operator's problem, not the network's.
	CliFailureCodeUnavailable: exitcode.ErrConfiguration,

	// The wallet already has a binding; retrying with the same input won't
	// help. (A repeat `complete` for the same pairing reads the same way.)
	CliFailureCodeWalletBoundElsewhere: exitcode.ErrAlreadyLinked,
	CliFailureCodeAlreadyCompleted:     exitcode.ErrAlreadyLinked,

	CliFailureCodeBadRequest:       exitcode.ErrNetwork,
	CliFailureCodeRateLimited:      exitcode.ErrNetwork,
	CliFailureCodeCrossOrigin:      exitcode.ErrNetwork,
	CliFailureCodeNotSignedIn:      exitcode.ErrNetwork,
	CliFailureCodeInvalidPublicKey: exitcode.ErrNetwork,
	CliFailureCodeUnknownNetwork:   exitcode.ErrNetwork,
	CliFailureCodeNetworkMismatch:  exitcode.ErrNetwork,
	CliFailureCodeNotFound:         exitcode.ErrNetwork,
	CliFailureCodeExpired:          exitcode.ErrNetwork,
	CliFailureCodeAlreadyUsed:      exitcode.ErrNetwork,
	CliFailureCodeNoProfile:        exitcode.ErrNetwork,
	CliFailureCodeNoKey:            exitcode.ErrNetwork,
	CliFailureCodeNotApproved:      exitcode.ErrNetwork,
	CliFailureCodeBadChallenge:     exitcode.ErrNetwork,
	CliFailureCodeKeyMismatch:      exitcode.ErrNetwork,
	CliFailureCodeBadHandoff:       exitcode.ErrNetwork,
	CliFailureCodeReplayed:         exitcode.ErrNetwork,
	CliFailureCodeNotLinked:        exitcode.ErrNetwork,
	CliFailureCodePrimaryWallet:    exitcode.ErrNetwork,
}

// ErrorFor returns the exit-code sentinel for a failure code from an error
// body, and false for a code this build does not know — a newer server, or a
// body that carried none. Callers fall back to the HTTP status then.
func ErrorFor(code CliFailureCode) (error, bool) {
	err, ok := failureErrors[code]
	return err, ok
}
