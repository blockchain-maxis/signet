package simulator

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// PathEnv names an explicit simulator binary, for development and
// non-standard installs (docs/CLI_RUST_BRIDGE.md §5, step 1).
const PathEnv = "SIGNET_SIMULATOR_PATH"

// ErrSimulatorNotFound is a missing simulator. Like a missing `stellar`, it
// is an environment problem, so it wraps exitcode.ErrConfiguration (exit 3).
var ErrSimulatorNotFound error = notFoundError{}

type notFoundError struct{}

func (notFoundError) Error() string {
	return "contract simulator not found — reinstall signet-cli or set `" + PathEnv + "`"
}

func (notFoundError) Unwrap() error { return exitcode.ErrConfiguration }

// BinaryName is the simulator's file name on this platform.
func BinaryName() string {
	if runtime.GOOS == "windows" {
		return "signet-simulator.exe"
	}
	return "signet-simulator"
}

// locator is Locate with its environment injectable for tests.
type locator struct {
	getenv     func(string) string
	executable func() (string, error)
	lookPath   func(string) (string, error)
}

var defaultLocator = locator{getenv: os.Getenv, executable: os.Executable, lookPath: exec.LookPath}

// Locate finds signet-simulator in the note's order, first match wins:
// $SIGNET_SIMULATOR_PATH, then next to the running signet binary, then PATH.
// Nothing found is ErrSimulatorNotFound. Only commands that execute a
// contract call it, so help and the rest of the CLI work without a
// simulator installed.
func Locate() (string, error) { return defaultLocator.locate() }

func (l locator) locate() (string, error) {
	if p := l.getenv(PathEnv); p != "" {
		if isExecutableFile(p) {
			return filepath.Abs(p)
		}
		return "", fmt.Errorf("%w (%s is set to %q, which is not an executable file)", ErrSimulatorNotFound, PathEnv, p)
	}

	if exe, err := l.executable(); err == nil {
		dirs := []string{filepath.Dir(exe)}
		// An install that symlinks signet onto PATH (a package manager's bin
		// directory) keeps the simulator beside the real file, not the link.
		if real, err := filepath.EvalSymlinks(exe); err == nil && filepath.Dir(real) != dirs[0] {
			dirs = append(dirs, filepath.Dir(real))
		}
		for _, dir := range dirs {
			if p := filepath.Join(dir, BinaryName()); isExecutableFile(p) {
				return p, nil
			}
		}
	}

	if p, err := l.lookPath(BinaryName()); err == nil {
		return p, nil
	}
	return "", ErrSimulatorNotFound
}

func isExecutableFile(p string) bool {
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || fi.Mode().Perm()&0o111 != 0
}

var simulatorVersionPattern = regexp.MustCompile(`^signet-simulator (\S+)`)

// Version runs `<path> --version` and returns the release it reports.
func Version(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return "", fmt.Errorf("%s --version: %s", path, strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("%s --version: %w", path, err)
	}
	m := simulatorVersionPattern.FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return "", fmt.Errorf("%s --version printed %q, not `signet-simulator <version> …`", path, strings.TrimSpace(string(out)))
	}
	return m[1], nil
}

// VersionWarning compares the simulator's release with the CLI's and
// returns a warning when they differ, or "" when they match or the CLI is a
// development build. It never fails a command: both binaries ship in one
// archive, and the handshake is what decides compatibility (§5).
func VersionWarning(ctx context.Context, path, cliVersion string) string {
	cli := strings.TrimPrefix(cliVersion, "v")
	if cli == "" || cli == "dev" {
		return ""
	}
	sim, err := Version(ctx, path)
	if err != nil {
		return fmt.Sprintf("warning: could not read the contract simulator's version (%v); continuing", err)
	}
	if strings.TrimPrefix(sim, "v") == cli {
		return ""
	}
	return fmt.Sprintf("warning: signet-simulator %s (%s) does not match signet %s; continuing — reinstall signet-cli if the sandbox misbehaves", sim, path, cli)
}

// Find locates the simulator and reports a version mismatch through warn.
// It is what a command that executes contract code calls before Start.
func Find(ctx context.Context, cliVersion string, warn func(string)) (string, error) {
	path, err := Locate()
	if err != nil {
		return "", err
	}
	if w := VersionWarning(ctx, path, cliVersion); w != "" && warn != nil {
		warn(w)
	}
	return path, nil
}
