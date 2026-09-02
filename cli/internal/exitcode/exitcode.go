// Package exitcode defines the CLI's process exit codes as their own leaf
// package, so both internal/cmd (which maps any error to one, for main() to
// pass to os.Exit) and packages like internal/link (whose own error types
// know which code they map to) can depend on the codes without a cycle
// between cmd and link.
package exitcode

// Kept small and deliberate: a CLI that ships as a prebuilt binary, with no
// preview deploy or browser console, is often diagnosed from its exit code
// alone (a CI log, a shell script's `$?`) — distinguishing "you gave it
// something invalid" from "something else went wrong" is worth the two
// constants beyond plain success/failure.
const (
	OK           = 0
	Generic      = 1
	InvalidInput = 2
)
