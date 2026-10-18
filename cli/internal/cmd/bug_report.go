package cmd

import (
	"fmt"
	"io"
	"net/url"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

func init() { register(groupOther, newBugReportCmd) }

// issuesNewURL is the issue tracker the pre-filled link points at.
const issuesNewURL = "https://github.com/blockchain-maxis/signet/issues/new"

// bugReportResult is the --json shape of `signet bug-report`.
type bugReportResult struct {
	Version    string        `json:"version"`
	Commit     string        `json:"commit"`
	OS         string        `json:"os"`
	Arch       string        `json:"arch"`
	Stellar    string        `json:"stellar"`
	Context    string        `json:"context"`
	Network    string        `json:"network"`
	Deployment string        `json:"deployment"`
	LastError  *LastError    `json:"lastError,omitempty"`
	Doctor     []doctorCheck `json:"doctor"`
	IssueURL   string        `json:"issueUrl"`
	Markdown   string        `json:"markdown"`
}

// newBugReportCmd assembles a redacted report a developer can paste into a new
// issue. It reads only local state: the build's version, the environment, the
// last recorded error, and the doctor results. It makes no network request and
// never opens the pre-filled URL itself.
func newBugReportCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "bug-report",
		Short: "Print a redacted bug report and a pre-filled issue link",
		Long: `Prints a Markdown block describing this build, the environment, the last
recorded error, and the doctor results, followed by a pre-filled
github.com/blockchain-maxis/signet issue URL.

The report is redacted and contains no secret keys, API keys, or Authorization
values. Nothing is sent anywhere: signet never uploads the report, and it never
opens the link for you. Review it, then open it yourself.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := depsFor(cmd)
			if err != nil {
				return err
			}
			resolved := deps.Config

			lastErr, _ := readLastError()

			stellar := "not found"
			if version, verr := stellarVersion(deps.KeysBinary); verr == nil {
				stellar = redact.Secrets(version)
			}

			result := bugReportResult{
				Version:    deps.Version,
				Commit:     deps.Commit,
				OS:         runtime.GOOS,
				Arch:       runtime.GOARCH,
				Stellar:    stellar,
				Context:    resolved.Context,
				Network:    resolved.Network,
				Deployment: describeDeployment(resolved.BaseURL),
				LastError:  lastErr,
				Doctor:     runDoctor(deps),
			}
			result.Markdown = buildBugReportMarkdown(result)
			result.IssueURL = issueURLFor(result.Markdown)

			return printerFor(cmd).Result(result, func(w io.Writer) error {
				if _, err := io.WriteString(w, result.Markdown); err != nil {
					return err
				}
				_, err := fmt.Fprintf(w, "\nReview the report above, then open it as a new issue here:\n\n%s\n", result.IssueURL)
				return err
			})
		},
	}
}

// describeDeployment summarises the deployment URL without leaking its path or
// query: "default" for the built-in deployment, otherwise the host only.
func describeDeployment(baseURL string) string {
	if baseURL == config.DefaultBaseURL {
		return "default"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" {
		return "custom"
	}
	return "custom (" + parsed.Host + ")"
}

func buildBugReportMarkdown(r bugReportResult) string {
	lines := []string{
		"## Signet bug report",
		"",
		fmt.Sprintf("- signet: %s (commit %s)", r.Version, r.Commit),
		fmt.Sprintf("- platform: %s/%s", r.OS, r.Arch),
		fmt.Sprintf("- stellar: %s", r.Stellar),
		fmt.Sprintf("- context: %s (network %s, %s URL)", r.Context, r.Network, r.Deployment),
	}
	if r.LastError != nil {
		lines = append(lines, fmt.Sprintf("- last error: %s", r.LastError.Message))
	} else {
		lines = append(lines, "- last error: none recorded")
	}

	lines = append(lines, "", "### doctor", "")
	for _, c := range r.Doctor {
		status := "ok"
		if !c.OK {
			status = "fail"
		}
		if c.Detail != "" {
			lines = append(lines, fmt.Sprintf("- %s: %s (%s)", c.Name, status, c.Detail))
			continue
		}
		lines = append(lines, fmt.Sprintf("- %s: %s", c.Name, status))
	}
	return strings.Join(lines, "\n") + "\n"
}

// issueURLFor builds the pre-filled new-issue URL. It is returned as text and
// never fetched.
func issueURLFor(markdown string) string {
	query := url.Values{}
	query.Set("title", "signet bug report")
	query.Set("body", markdown)
	return issuesNewURL + "?" + query.Encode()
}
