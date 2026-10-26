package cmd

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/dev"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/realtx"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// ciFailOnClasses are what --fail-on takes (#639): the replay classes, and
// the interface and storage layout findings.
var ciFailOnClasses = []string{simulator.ClassBreaking, simulator.ClassBehavioural, simulator.ClassCost, "spec", "layout"}

// ciDefaultFailOn is --fail-on's default.
const ciDefaultFailOn = "breaking,spec,layout"

// ciFlags are signet dev --ci's outputs and what fails it.
type ciFlags struct {
	bundle, report, junit, failOn string
	// classes are --fail-on, parsed.
	classes []string
}

// parseFailOn reads --fail-on: a comma-separated list of ciFailOnClasses.
func parseFailOn(s string) ([]string, error) {
	var out []string
	for _, c := range strings.Split(s, ",") {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if !slices.Contains(ciFailOnClasses, c) {
			return nil, &inputError{fmt.Sprintf("--fail-on takes %s, not %q", strings.Join(ciFailOnClasses, ", "), c)}
		}
		if !slices.Contains(out, c) {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return nil, &inputError{"--fail-on needs at least one of " + strings.Join(ciFailOnClasses, ", ")}
	}
	return out, nil
}

// ciReport is --report's JSON (sandbox/protocol/schema/v1/ci-report.json).
type ciReport struct {
	Version    int      `json:"version"`
	Contract   string   `json:"contract"`
	Network    string   `json:"network,omitempty"`
	ForkLedger uint32   `json:"fork_ledger"`
	Protocol   int      `json:"protocol"`
	Crate      string   `json:"crate"`
	Wasm       string   `json:"wasm,omitempty"`
	Offline    bool     `json:"offline"`
	Note       string   `json:"note,omitempty"`
	FailOn     []string `json:"fail_on"`
	// Result is clean, failed or build_failed.
	Result   string `json:"result"`
	ExitCode int    `json:"exit_code"`
	Build    struct {
		DurationMS float64 `json:"duration_ms"`
		Error      string  `json:"error,omitempty"`
	} `json:"build"`
	Summary map[string]int `json:"summary"`
	Replays []ciReplay     `json:"replays"`
	Spec    []ciFinding    `json:"spec"`
	Layout  []ciFinding    `json:"layout"`
	Timing  *ciTiming      `json:"timing,omitempty"`
}

// ciReplay is one replay in the report.
type ciReplay struct {
	Name   string `json:"name"`
	Source string `json:"source"` // saved or real
	Tx     string `json:"tx,omitempty"`
	Link   string `json:"link,omitempty"`
	// Group is where the terminal lists it: expected, a class,
	// low-fidelity, or "" with no differences.
	Group       string           `json:"group"`
	Failed      bool             `json:"failed"`
	Differences []dev.Difference `json:"differences"`
	Verdict     *dev.Verdict     `json:"verdict,omitempty"`
	Fidelity    *realtx.Fidelity `json:"fidelity,omitempty"`
}

// ciFinding is an interface change or a storage layout finding.
type ciFinding struct {
	Name   string `json:"name"`
	Class  string `json:"class,omitempty"`
	Reason string `json:"reason"`
	Failed bool   `json:"failed"`
}

type ciTiming struct {
	InstallMS float64 `json:"install_ms"`
	SwapMS    float64 `json:"swap_ms"`
	AMS       float64 `json:"a_ms"`
	BMS       float64 `json:"b_ms"`
	DiffMS    float64 `json:"diff_ms"`
}

// failures is how many items failed.
func (r *ciReport) failures() int {
	n := 0
	for _, x := range r.Replays {
		if x.Failed {
			n++
		}
	}
	for _, f := range append(append([]ciFinding{}, r.Spec...), r.Layout...) {
		if f.Failed {
			n++
		}
	}
	return n
}

// judge fills the report from a cycle: a replay fails when it missed its
// expect, or has a difference in a --fail-on class (a low-fidelity real
// replay only with fail_on_low_fidelity); a breaking interface change fails
// with spec, a layout finding with layout.
func (r *ciReport) judge(c *dev.Cycle, failOnLow bool) {
	r.Summary = map[string]int{}
	r.Replays, r.Spec, r.Layout = []ciReplay{}, []ciFinding{}, []ciFinding{}
	for _, o := range c.Outcomes {
		diffs := dev.Differences(o)
		x := ciReplay{Name: o.Name, Source: "saved", Group: dev.Group(o, diffs, failOnLow), Differences: diffs, Verdict: o.Verdict}
		if x.Differences == nil {
			x.Differences = []dev.Difference{}
		}
		if real := o.Real; real != nil {
			fidelity := real.Fidelity
			x.Source, x.Tx, x.Link, x.Fidelity = "real", real.Hash, real.Link, &fidelity
		}
		switch x.Group {
		case "expected":
			x.Failed = true
		case "low-fidelity":
		default:
			for _, d := range diffs {
				x.Failed = x.Failed || slices.Contains(r.FailOn, d.Class)
			}
		}
		if x.Group != "" {
			r.Summary[x.Group]++
		}
		r.Replays = append(r.Replays, x)
	}
	if s := c.Spec; s != nil {
		for _, ch := range s.Changes {
			r.Spec = append(r.Spec, ciFinding{
				Name: ch.Kind + " " + ch.Path, Class: ch.Class, Reason: ch.Reason,
				Failed: ch.Class == simulator.ClassBreaking && slices.Contains(r.FailOn, "spec"),
			})
		}
	}
	if l := c.Layout; l != nil {
		for _, f := range l.Findings {
			r.Layout = append(r.Layout, ciFinding{
				Name: fmt.Sprintf("%s (%s, %s)", f.Key, f.UDT, f.Evidence), Reason: f.Reason,
				Failed: slices.Contains(r.FailOn, "layout"),
			})
		}
	}
	t := c.Timing
	r.Timing = &ciTiming{InstallMS: ms(t.Install), SwapMS: ms(t.Swap), AMS: ms(t.A), BMS: ms(t.B), DiffMS: ms(t.Diff)}
	r.Result, r.ExitCode = "clean", exitcode.OK
	if r.failures() > 0 {
		r.Result, r.ExitCode = "failed", exitcode.DiffFound
	}
}

// buildFailed fills the report for a build that failed.
func (r *ciReport) buildFailed(took time.Duration, err error) {
	r.Build.DurationMS, r.Build.Error = ms(took), err.Error()
	r.Summary, r.Replays, r.Spec, r.Layout = map[string]int{}, []ciReplay{}, []ciFinding{}, []ciFinding{}
	r.Result, r.ExitCode = "build_failed", exitcode.BuildFailed
}

// write writes the report and the JUnit file, where asked for.
func (r *ciReport) write(flags ciFlags) error {
	if flags.report != "" {
		raw, err := json.MarshalIndent(r, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(flags.report, append(raw, '\n'), 0o644); err != nil {
			return fmt.Errorf("%w: writing the report: %v", exitcode.ErrConfiguration, err)
		}
	}
	if flags.junit != "" {
		raw, err := r.junit()
		if err != nil {
			return err
		}
		if err := os.WriteFile(flags.junit, raw, 0o644); err != nil {
			return fmt.Errorf("%w: writing the JUnit file: %v", exitcode.ErrConfiguration, err)
		}
	}
	return nil
}

// errDiffFound is --ci's exit 10.
type diffFoundError struct{ n int }

func (e *diffFoundError) Error() string {
	return fmt.Sprintf("%d %s failed the checks (--fail-on)", e.n, plural(e.n, "item", "items"))
}

func (e *diffFoundError) ExitCode() int { return exitcode.DiffFound }

type junitSuites struct {
	XMLName  xml.Name     `xml:"testsuites"`
	Name     string       `xml:"name,attr"`
	Tests    int          `xml:"tests,attr"`
	Failures int          `xml:"failures,attr"`
	Suites   []junitSuite `xml:"testsuite"`
}

type junitSuite struct {
	Name     string      `xml:"name,attr"`
	Tests    int         `xml:"tests,attr"`
	Failures int         `xml:"failures,attr"`
	Cases    []junitCase `xml:"testcase"`
}

type junitCase struct {
	Classname string        `xml:"classname,attr"`
	Name      string        `xml:"name,attr"`
	Failure   *junitFailure `xml:"failure,omitempty"`
	Output    string        `xml:"system-out,omitempty"`
}

type junitFailure struct {
	Message string `xml:"message,attr"`
	Type    string `xml:"type,attr"`
	Text    string `xml:",chardata"`
}

// junit is the report as JUnit XML: one testcase per replay, interface
// change and layout finding, or one for the build when it failed.
func (r *ciReport) junit() ([]byte, error) {
	suites := junitSuites{Name: "signet dev " + r.Contract}
	add := func(s junitSuite) {
		for _, c := range s.Cases {
			s.Tests++
			if c.Failure != nil {
				s.Failures++
			}
		}
		suites.Tests += s.Tests
		suites.Failures += s.Failures
		suites.Suites = append(suites.Suites, s)
	}
	if r.Result == "build_failed" {
		add(junitSuite{Name: "build", Cases: []junitCase{{Classname: "build", Name: r.Crate,
			Failure: &junitFailure{Message: "the build failed", Type: "build", Text: r.Build.Error}}}})
	} else {
		replays := junitSuite{Name: "replays"}
		for _, x := range r.Replays {
			c := junitCase{Classname: "replay." + x.Source, Name: x.Name}
			var lines []string
			first := ""
			if v := x.Verdict; v != nil && !v.Pass {
				first = fmt.Sprintf("expected %s: %s", v.Expect, v.Reason)
				lines = append(lines, first)
			}
			for _, d := range x.Differences {
				if first == "" {
					first = d.Text
				}
				lines = append(lines, d.Class+": "+d.Text)
			}
			if f := x.Fidelity; f != nil && !f.High {
				lines = append(lines, f.Reason)
			}
			if x.Failed {
				c.Failure = &junitFailure{Message: first, Type: x.Group, Text: strings.Join(lines, "\n")}
			} else if len(lines) > 0 {
				c.Output = strings.Join(lines, "\n")
			}
			replays.Cases = append(replays.Cases, c)
		}
		add(replays)
		for _, group := range []struct {
			name     string
			findings []ciFinding
		}{{"spec", r.Spec}, {"layout", r.Layout}} {
			s := junitSuite{Name: group.name}
			for _, f := range group.findings {
				c := junitCase{Classname: group.name, Name: f.Name}
				if f.Failed {
					c.Failure = &junitFailure{Message: f.Reason, Type: group.name}
				} else {
					c.Output = f.Reason
				}
				s.Cases = append(s.Cases, c)
			}
			add(s)
		}
	}
	raw, err := xml.MarshalIndent(suites, "", "  ")
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), append(raw, '\n')...), nil
}
