package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
	"github.com/blockchain-maxis/signet/cli/internal/networkcheck"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

func init() { register(groupOther, newDoctorCmd) }

// doctorCheck is one environment check (#619): ok, warn or fail, with a
// one-line fix when it is not ok. Detail and Fix are short and non-sensitive:
// the local checks are embedded verbatim in `signet bug-report`, so they
// never carry a secret, a URL path or a home directory.
type doctorCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"` // ok, warn, fail
	Detail string `json:"detail,omitempty"`
	Fix    string `json:"fix,omitempty"`
}

// doctorResult is the --json shape of `signet doctor`.
type doctorResult struct {
	Checks []doctorCheck `json:"checks"`
}

// annotationToleratesBadConfig marks a command that runs when the config
// file does not parse, to report it.
const annotationToleratesBadConfig = "signet.tolerates-bad-config"

const (
	statusOK   = "ok"
	statusWarn = "warn"
	statusFail = "fail"

	// skewWarn and skewFail bound the local clock against the deployment's:
	// SEP-10 challenges have five-minute time bounds.
	skewWarn = 30 * time.Second
	skewFail = 4 * time.Minute
)

// newDoctorCmd checks what a first run trips over (#619): the stellar CLI,
// identities, the config file and context, the deployment and its network,
// and the clock.
func newDoctorCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check the local environment and the deployment signet uses",
		Long: `Checks what a first run depends on, and says what to do about anything
that is not right:

  - the stellar CLI is installed and new enough;
  - at least one stellar identity exists;
  - the config file parses and its current context exists;
  - the deployment answers, and can link a wallet (its pairing check);
  - the deployment serves the network signet is set to;
  - the local clock is close to the deployment's (SEP-10 challenges are
    valid for five minutes, so a skewed clock fails sign-in with no hint).

Each check is ok, warn or fail, with a one-line fix. Exits 3 when any check
fails. It never prints a secret, and writes paths under your home as ~/….`,
		Args:        cobra.NoArgs,
		Annotations: map[string]string{annotationToleratesBadConfig: "true"},
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			checks := append(runDoctor(deps), remoteChecks(cmd.Context(), deps)...)
			if err := printerFor(cmd).Result(doctorResult{Checks: checks}, func(w io.Writer) error {
				return writeChecks(w, checks)
			}); err != nil {
				return err
			}
			var failed []string
			for _, c := range checks {
				if c.Status == statusFail {
					failed = append(failed, c.Name)
				}
			}
			if len(failed) > 0 {
				return fmt.Errorf("%w: %s failed", exitcode.ErrConfiguration, strings.Join(failed, ", "))
			}
			return nil
		},
	}
}

func writeChecks(w io.Writer, checks []doctorCheck) error {
	var b strings.Builder
	for _, c := range checks {
		fmt.Fprintf(&b, "%-4s  %s", c.Status, c.Name)
		if c.Detail != "" {
			fmt.Fprintf(&b, ": %s", c.Detail)
		}
		b.WriteString("\n")
		if c.Fix != "" {
			fmt.Fprintf(&b, "      fix: %s\n", c.Fix)
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// runDoctor runs the local checks: no network request. `bug-report` embeds
// them, so both report the same environment.
func runDoctor(deps Deps) []doctorCheck {
	stellar := checkStellarCLI(deps.KeysBinary)
	return []doctorCheck{
		checkConfigFile(deps),
		stellar,
		checkIdentities(deps.KeysBinary, stellar.Status == statusOK),
		checkCacheDir(),
	}
}

func checkConfigFile(deps Deps) doctorCheck {
	c := doctorCheck{Name: "config file"}
	if deps.ConfigError != nil {
		c.Status, c.Detail = statusFail, "does not parse: "+redact.Secrets(tildeError(deps.ConfigError))
		c.Fix = "fix the JSON in the config file, or move it aside to start from defaults"
		return c
	}
	path, err := config.Path()
	if err != nil {
		c.Status, c.Detail = statusFail, redact.Secrets(err.Error())
		return c
	}
	if _, statErr := os.Stat(path); statErr != nil {
		if os.IsNotExist(statErr) {
			c.Status, c.Detail = statusOK, "not present, defaults in use"
			return c
		}
		c.Status, c.Detail = statusFail, redact.Secrets(tildeError(statErr))
		return c
	}
	f, err := config.Load()
	if err != nil {
		c.Status, c.Detail = statusFail, "does not parse: "+redact.Secrets(tildeError(err))
		return c
	}
	if name := deps.Config.Context; name != "" && len(f.Contexts) > 0 {
		if _, ok := f.Contexts[name]; !ok {
			c.Status, c.Detail = statusFail, fmt.Sprintf("the current context %q does not exist", name)
			c.Fix = "signet context list, then signet context use <name>"
			return c
		}
		c.Detail = fmt.Sprintf("parses; context %q", name)
	} else {
		c.Detail = "parses"
	}
	c.Status = statusOK
	return c
}

func checkStellarCLI(binary string) doctorCheck {
	c := doctorCheck{Name: "stellar CLI"}
	if err := keys.CheckStellarCLI(binary); err != nil {
		c.Status, c.Detail = statusFail, redact.Secrets(err.Error())
		c.Fix = "install or upgrade it: https://developers.stellar.org/docs/tools/cli/install-cli"
		return c
	}
	c.Status = statusOK
	if version, err := stellarVersion(binary); err == nil {
		c.Detail = redact.Secrets(version)
	} else {
		c.Detail = "present"
	}
	return c
}

func checkIdentities(binary string, haveStellar bool) doctorCheck {
	c := doctorCheck{Name: "identities"}
	if !haveStellar {
		c.Status, c.Detail = statusWarn, "not checked: needs the stellar CLI"
		return c
	}
	if binary == "" {
		binary = keys.DefaultBinary
	}
	names, err := keys.List(binary)
	switch {
	case err != nil:
		c.Status, c.Detail = statusFail, redact.Secrets(err.Error())
	case len(names) == 0:
		c.Status, c.Detail = statusFail, "no stellar identities"
		c.Fix = "stellar keys generate <name> (or stellar keys add <name>), then pass --source <name>"
	default:
		c.Status, c.Detail = statusOK, fmt.Sprintf("%d found", len(names))
	}
	return c
}

func checkCacheDir() doctorCheck {
	c := doctorCheck{Name: "cache directory"}
	dir, err := cacheDir()
	if err != nil {
		c.Status, c.Detail = statusFail, redact.Secrets(err.Error())
		return c
	}
	if mkErr := os.MkdirAll(dir, 0o700); mkErr != nil {
		c.Status, c.Detail = statusFail, redact.Secrets(tildeError(mkErr))
		return c
	}
	c.Status, c.Detail = statusOK, "ready"
	return c
}

// tildeError writes any home-directory path in an error as ~.
func tildeError(err error) string {
	home, herr := os.UserHomeDir()
	if herr != nil || home == "" {
		return err.Error()
	}
	return strings.ReplaceAll(err.Error(), home, "~")
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

// v1Health is what /api/v1/health answers, inside its {data} envelope;
// /api/health answers the same checks without the envelope or the network.
type v1Health struct {
	Status            string `json:"status"`
	Network           string `json:"network"`
	NetworkPassphrase string `json:"networkPassphrase"`
	Checks            struct {
		DB       string `json:"db"`
		Registry string `json:"registry"`
		Pairing  string `json:"pairing"`
	} `json:"checks"`
}

// remoteChecks ask the deployment: is it there and able to link, does it
// serve the network signet is set to, and is the clock close to its own.
func remoteChecks(ctx context.Context, deps Deps) []doctorCheck {
	host := deps.Config.BaseURL
	if u, err := url.Parse(deps.Config.BaseURL); err == nil && u.Host != "" {
		host = u.Host
	}
	deployment := doctorCheck{Name: "deployment"}
	network := doctorCheck{Name: "network"}
	clock := doctorCheck{Name: "clock"}

	client := &http.Client{Timeout: 10 * time.Second}
	type answer struct {
		status int
		header http.Header
		body   []byte
	}
	get := func(path string) (answer, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(deps.Config.BaseURL, "/")+path, nil)
		if err != nil {
			return answer{}, err
		}
		res, err := client.Do(req)
		if err != nil {
			return answer{}, err
		}
		defer func() { _ = res.Body.Close() }()
		body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		return answer{res.StatusCode, res.Header, body}, err
	}

	res, err := get("/api/v1/health")
	v1 := err == nil && res.status != http.StatusNotFound
	if !v1 {
		res, err = get("/api/health")
	}
	body := res.body
	if err != nil {
		deployment.Status, deployment.Detail = statusFail, fmt.Sprintf("%s did not answer: %s", host, redact.Secrets(errorWithoutURL(err)))
		deployment.Fix = "check --url (or the context's url) and your connection"
		network.Status, network.Detail = statusWarn, "not checked: the deployment did not answer"
		clock.Status, clock.Detail = statusWarn, "not checked: the deployment did not answer"
		return []doctorCheck{deployment, network, clock}
	}

	var health v1Health
	if v1 {
		var envelope struct {
			Data v1Health `json:"data"`
		}
		_ = json.Unmarshal(body, &envelope)
		health = envelope.Data
	} else {
		_ = json.Unmarshal(body, &health)
	}
	switch {
	case res.status == http.StatusServiceUnavailable:
		deployment.Status, deployment.Detail = statusFail, fmt.Sprintf("%s answers 503: every CLI route will too", host)
		deployment.Fix = "the deployment needs its database (DATABASE_URL); ask its operator"
	case res.status >= 400:
		deployment.Status, deployment.Detail = statusFail, fmt.Sprintf("%s answered %d to its health check", host, res.status)
		deployment.Fix = "check --url points at a Signet deployment"
	case health.Checks.Pairing == "down":
		deployment.Status = statusFail
		deployment.Detail = fmt.Sprintf("%s is up but cannot link wallets (pairing is down: database %s, registry %s)", host, orUnknown(health.Checks.DB), orUnknown(health.Checks.Registry))
		deployment.Fix = "wait, or ask the deployment's operator: signet link fails until pairing is up"
	case health.Status == "degraded":
		deployment.Status, deployment.Detail = statusWarn, fmt.Sprintf("%s is degraded, pairing %s", host, orUnknown(health.Checks.Pairing))
	default:
		deployment.Status, deployment.Detail = statusOK, fmt.Sprintf("%s, pairing %s", host, orUnknown(health.Checks.Pairing))
	}

	// The network: v1 health names it; an older deployment publishes it in
	// its stellar.toml (#618).
	passphrase := health.NetworkPassphrase
	if passphrase == "" {
		if d, err := api.New(deps.Config.BaseURL, api.Options{Insecure: deps.Insecure}); err == nil {
			if disc, err := d.Discover(ctx); err == nil {
				passphrase = disc.NetworkPassphrase
			}
		}
	}
	if passphrase == "" {
		network.Status, network.Detail = statusWarn, "the deployment does not say which network it serves; it is checked when pairing starts"
	} else if err := networkcheck.Compare(deps.Config.Network, api.Discovery{URL: host, NetworkPassphrase: passphrase}); err != nil {
		network.Status = statusFail
		network.Detail = redact.Secrets(strings.TrimPrefix(err.Error(), exitcode.ErrConfiguration.Error()+": "))
		var mismatch *networkcheck.MismatchError
		if errors.As(err, &mismatch) {
			if name, ok := networkcheck.NameFor(mismatch.Passphrase); ok {
				network.Fix = fmt.Sprintf("use --network %s, or a context on %s", name, name)
			}
		}
	} else {
		name, _ := networkcheck.NameFor(passphrase)
		network.Status, network.Detail = statusOK, orUnknown(name)
	}

	// The clock, against the deployment's Date header.
	served, err := http.ParseTime(res.header.Get("Date"))
	if err != nil {
		clock.Status, clock.Detail = statusWarn, "the deployment sent no Date header to compare with"
		return []doctorCheck{deployment, network, clock}
	}
	now := time.Now
	if deps.Now != nil {
		now = deps.Now
	}
	skew := now().Sub(served).Round(time.Second)
	abs, direction := skew, "ahead of"
	if skew < 0 {
		abs, direction = -skew, "behind"
	}
	switch {
	case abs > skewFail:
		clock.Status, clock.Detail = statusFail, fmt.Sprintf("this machine's clock is %s %s the deployment's", abs, direction)
		clock.Fix = "turn on network time sync: sign-in challenges are valid for five minutes"
	case abs > skewWarn:
		clock.Status, clock.Detail = statusWarn, fmt.Sprintf("this machine's clock is %s %s the deployment's", abs, direction)
		clock.Fix = "turn on network time sync"
	default:
		clock.Status, clock.Detail = statusOK, fmt.Sprintf("within %s of the deployment's", skewWarn)
	}
	return []doctorCheck{deployment, network, clock}
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

// errorWithoutURL drops the request URL net/http puts in its errors: the
// host is already in the check's detail.
func errorWithoutURL(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}
