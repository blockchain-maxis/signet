// Package exitcode defines the CLI's process exit codes and its error
// taxonomy as their own leaf package, so both internal/cmd (which maps any
// error to a code, for main() to pass to os.Exit) and packages like
// internal/link/internal/keys (whose own errors participate in the
// taxonomy) can depend on it without a cycle between cmd and them.
//
// Every failure class the CLI documents is a sentinel error here, wrapped
// with fmt.Errorf's %w at the point something actually fails and checked
// with errors.Is — never by matching message text, which is free to change
// between releases and was exactly the problem #264's --json mode exists to
// avoid on stdout; the same principle applies to the process's exit code.
package exitcode

import "errors"

// Kept small and deliberate: a CLI that ships as a prebuilt binary, with no
// preview deploy or browser console, is often diagnosed from its exit code
// alone (a CI log, a shell script's `$?`).
const (
	OK      = 0
	Generic = 1
	// InvalidInput is link.ValidationError's code (internal/cmd.ExitCoder),
	// not part of the sentinel table below — malformed input is caught before
	// any of these failure classes could apply.
	InvalidInput = 2

	Configuration    = 3
	NoIdentity       = 4
	SigningFailure   = 5
	Network          = 6
	Timeout          = 7
	ApprovalRejected = 8
	AlreadyLinked    = 9
)

// Sentinel errors for each documented failure class beyond invalid input.
// Some (Configuration, NoIdentity) already have a real caller today;
// SigningFailure/Network/Timeout/ApprovalRejected/AlreadyLinked are defined
// now so the commands that will raise them (signing via internal/keys,
// talking to a deployment via internal/spec, the browser-approval flow) have
// a stable, already-documented code to wrap into from day one, rather than
// retrofitting the taxonomy once those land.
var (
	// ErrConfiguration: the config file, a flag, or an environment variable
	// is missing, unreadable, or unusable — including a missing/too-old
	// `stellar` CLI (internal/keys.ErrStellarNotFound/ErrStellarTooOld both
	// wrap this too), since that's an environment dependency problem, not a
	// property of what the user typed.
	ErrConfiguration = errors.New("configuration error")

	// ErrNoIdentity: no usable signing identity could be resolved — asked
	// stellar for one and it doesn't have it, as opposed to stellar itself
	// being missing or too old (that's ErrConfiguration).
	ErrNoIdentity = errors.New("no identity available")

	// ErrSigningFailure: identity resolution succeeded but the transaction
	// itself could not be signed.
	ErrSigningFailure = errors.New("signing failed")

	// ErrNetwork: a Signet deployment could not be reached or returned an
	// unexpected response.
	ErrNetwork = errors.New("network error")

	// ErrTimeout: an operation (a network call, an interactive approval)
	// exceeded its deadline.
	ErrTimeout = errors.New("timed out")

	// ErrApprovalRejected: the developer (or the deployment, on their behalf)
	// explicitly declined the link/claim.
	ErrApprovalRejected = errors.New("approval rejected")

	// ErrAlreadyLinked: the target wallet is already linked to a profile —
	// a conflict, not a transient failure; retrying with the same input
	// won't help.
	ErrAlreadyLinked = errors.New("wallet already linked")
)

// sentinelCodes pairs each sentinel above with its exit code, in the same
// order they're declared — the single source CodeFor and the CLI docs both
// derive from, so the pairing can't drift between the two.
var sentinelCodes = []struct {
	err  error
	code int
}{
	{ErrConfiguration, Configuration},
	{ErrNoIdentity, NoIdentity},
	{ErrSigningFailure, SigningFailure},
	{ErrNetwork, Network},
	{ErrTimeout, Timeout},
	{ErrApprovalRejected, ApprovalRejected},
	{ErrAlreadyLinked, AlreadyLinked},
}

// CodeFor returns the exit code for the first sentinel err matches via
// errors.Is, and true. It returns (Generic, false) when err doesn't
// participate in this taxonomy at all — internal/cmd.ExitCode falls back to
// checking the ExitCoder interface (link.ValidationError's mechanism) before
// finally defaulting to Generic itself.
func CodeFor(err error) (int, bool) {
	if err == nil {
		return OK, true
	}
	for _, s := range sentinelCodes {
		if errors.Is(err, s.err) {
			return s.code, true
		}
	}
	return Generic, false
}
