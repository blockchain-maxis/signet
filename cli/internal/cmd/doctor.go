package cmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

func init() { register(groupOther, newDoctorCmd) }

// doctorCheck is one environment check. Detail is a short, non-sensitive
// status: it is embedded verbatim in `signet bug-report`, so it never carries
// a filesystem path, a URL, or anything else that identifies the machine.
type doctorCheck struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

// doctorResult is the --json shape of `signet doctor`.
type doctorResult struct {
	Checks []doctorCheck `json:"checks"`
}

// newDoctorCmd reports on the local environment signet depends on. It always
// succeeds: its job is to describe the environment, not to gate a script, and
// a missing optional dependency is a finding rather than a command failure.
func newDoctorCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check the local environment signet depends on",
		Long: `Reports whether the pieces signet needs are present and usable: the
config file, the stellar CLI, and the cache directory bug reports use.

It never makes a network request and never prints a secret, and it exits
successfully whether or not every check passes. A failed check is a finding,
not an error.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			checks := runDoctor(deps)
			return printerFor(cmd).Result(doctorResult{Checks: checks}, func(w io.Writer) error {
				for _, c := range checks {
					status := "ok"
					if !c.OK {
						status = "fail"
					}
					if c.Detail != "" {
						if _, err := fmt.Fprintf(w, "%s: %s (%s)\n", c.Name, status, c.Detail); err != nil {
							return err
						}
						continue
					}
					if _, err := fmt.Fprintf(w, "%s: %s\n", c.Name, status); err != nil {
						return err
					}
				}
				return nil
			})
		},
	}
}

// runDoctor runs every check. It is shared by the `doctor` command and
// `bug-report`, so both report the same environment.
func runDoctor(deps Deps) []doctorCheck {
	return []doctorCheck{
		checkConfigFile(),
		checkStellarCLI(deps.KeysBinary),
		checkCacheDir(),
	}
}

func checkConfigFile() doctorCheck {
	path, err := config.Path()
	if err != nil {
		return doctorCheck{Name: "config file", OK: false, Detail: redact.Secrets(err.Error())}
	}
	if _, statErr := os.Stat(path); statErr != nil {
		if os.IsNotExist(statErr) {
			return doctorCheck{Name: "config file", OK: true, Detail: "not present, defaults in use"}
		}
		return doctorCheck{Name: "config file", OK: false, Detail: redact.Secrets(statErr.Error())}
	}
	return doctorCheck{Name: "config file", OK: true, Detail: "readable"}
}

func checkStellarCLI(binary string) doctorCheck {
	if err := keys.CheckStellarCLI(binary); err != nil {
		return doctorCheck{Name: "stellar CLI", OK: false, Detail: redact.Secrets(err.Error())}
	}
	version, err := stellarVersion(binary)
	if err != nil {
		return doctorCheck{Name: "stellar CLI", OK: true, Detail: "present"}
	}
	return doctorCheck{Name: "stellar CLI", OK: true, Detail: redact.Secrets(version)}
}

func checkCacheDir() doctorCheck {
	dir, err := cacheDir()
	if err != nil {
		return doctorCheck{Name: "cache directory", OK: false, Detail: redact.Secrets(err.Error())}
	}
	if mkErr := os.MkdirAll(dir, 0o700); mkErr != nil {
		return doctorCheck{Name: "cache directory", OK: false, Detail: redact.Secrets(mkErr.Error())}
	}
	return doctorCheck{Name: "cache directory", OK: true, Detail: "ready"}
}

// stellarVersion runs `<binary> --version` and returns its trimmed output.
func stellarVersion(binary string) (string, error) {
	if binary == "" {
		binary = keys.DefaultBinary
	}
	if _, err := exec.LookPath(binary); err != nil {
		return "", err
	}
	out, err := exec.Command(binary, "--version").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
