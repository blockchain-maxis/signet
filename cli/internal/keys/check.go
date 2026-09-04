package keys

import (
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// MinimumStellarVersion is the oldest `stellar` CLI version this tool relies
// on: `tx sign` gained `--sign-with-key` and reading the transaction from
// stdin in 25.2.0, and both are assumed present rather than probed for.
const MinimumStellarVersion = "25.2.0"

// StellarInstallURL is named in every "not found"/"too old" error so the
// message is actionable — it points at how to fix the problem, not just what
// it is.
const StellarInstallURL = "https://developers.stellar.org/docs/tools/cli/install-cli"

// ErrStellarNotFound and ErrStellarTooOld are sentinels: callers can
// distinguish the two failure modes with errors.Is without parsing message
// text, and internal/cmd's exit-code classifier maps them to distinct codes.
var (
	ErrStellarNotFound = errors.New("stellar CLI not found on PATH")
	ErrStellarTooOld   = errors.New("stellar CLI is older than the required minimum version")
)

var versionPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

type semver [3]int

// parseSemver extracts the first X.Y.Z it finds in s. `stellar --version`'s
// exact surrounding text (a program name, a commit hash, multiple lines) is
// not something this package should have to match precisely — a resilient
// caller looks for the number, not the sentence around it.
func parseSemver(s string) (semver, bool) {
	m := versionPattern.FindStringSubmatch(s)
	if m == nil {
		return semver{}, false
	}
	var v semver
	for i := range v {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return semver{}, false
		}
		v[i] = n
	}
	return v, true
}

func (v semver) String() string {
	return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2])
}

// compare returns -1, 0, or 1 as v is less than, equal to, or greater than o.
func (v semver) compare(o semver) int {
	for i := range v {
		if v[i] != o[i] {
			if v[i] < o[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// CheckStellarCLI verifies that binary is on PATH and reports a version at
// least MinimumStellarVersion, via `<binary> --version`. Call this before
// doing any work that depends on the stellar CLI (resolving an identity,
// signing) — a missing binary and a too-old version each produce a distinct,
// actionable error rather than letting the real failure surface as a raw
// exec error or an unrecognized-flag message pointing at the wrong tool.
func CheckStellarCLI(binary string) error {
	if binary == "" {
		binary = DefaultBinary
	}

	if _, err := exec.LookPath(binary); err != nil {
		return fmt.Errorf(
			"%w: %w: %q — install it from %s (%s or newer is required)",
			exitcode.ErrConfiguration, ErrStellarNotFound, binary, StellarInstallURL, MinimumStellarVersion,
		)
	}

	stdout, stderr, err := run(binary, "--version")
	if err != nil {
		msg := strings.TrimSpace(string(stderr))
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("%w: could not determine %s's version: %s", exitcode.ErrConfiguration, binary, msg)
	}

	minimum, ok := parseSemver(MinimumStellarVersion)
	if !ok {
		// Unreachable with the constant above, but a parse failure here must
		// never silently pass a check meant to catch exactly this class of bug.
		return fmt.Errorf("internal error: MinimumStellarVersion %q does not parse as X.Y.Z", MinimumStellarVersion)
	}

	found, ok := parseSemver(string(stdout))
	if !ok {
		return fmt.Errorf("could not parse a version number from %s --version output: %q", binary, strings.TrimSpace(string(stdout)))
	}

	if found.compare(minimum) < 0 {
		return fmt.Errorf(
			"%w: %w: %s %s, need %s or newer — upgrade from %s",
			exitcode.ErrConfiguration, ErrStellarTooOld, binary, found, MinimumStellarVersion, StellarInstallURL,
		)
	}
	return nil
}
