// Package render turns a sandbox result into what a person reads in the
// terminal (#556, docs/CONTRACT_SANDBOX_DESIGN.md §8).
//
// A call that comes back without a host error can mean three different
// things, and saying "success" for all of them would tell someone a handle
// was claimed when nothing was submitted anywhere:
//
//   - a read: nothing written, no auth needed: `→ 2`;
//   - a write preview: what would be written and who would have to sign,
//     then that nothing was submitted;
//   - a contract error: the contract working as intended, by name.
//
// Host errors (budget, traps), simulator failures and timeouts each read as
// their own category, never as the contract failing. Every rendering ends
// with a provenance footer: what it ran against.
package render

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Kind is what a result means.
type Kind int

const (
	Read Kind = iota
	WritePreview
	ContractError
	HostError
	SimulatorError
	Timeout
)

// Call is one call's outcome, in the terms the rendering needs.
type Call struct {
	Function string
	// Value is the decoded return value as JSON text; empty or "null" for
	// none.
	Value string
	// Writes counts the entries the call would write.
	Writes int
	// Signers are the addresses whose auth the call required, each with the
	// function its auth covered.
	Signers []Signer
	// Error, for a contract or host error.
	Error *Refusal
	// Failure is the message of a simulator failure or a timeout.
	Failure string
	Kind    Kind
}

// Signer is one address whose auth a call needed, and for what.
type Signer struct {
	Address  string
	Function string
}

// Refusal is a contract_error.
type Refusal struct {
	// Name, Code and Doc come from the contract's spec, for a contract error.
	Name string
	Code int
	Doc  string
	// HostType and HostCode are the host's terms, for a host error
	// (Budget, ExceededLimit).
	HostType, HostCode string
}

// Provenance is what a result ran against.
type Provenance struct {
	Network    string
	ForkLedger uint32
	ForkTime   time.Time
	Protocol   int
	Drift      int
	// Overrides are human phrases for everything that departs from the
	// network: "session demo", "wasm 5c1f…e2 swapped in", "budget 2x".
	Overrides []string
	// AuthMode is record, strict or enforce (#557). Record and strict
	// check no signatures.
	AuthMode string
}

// AuthMocked reports whether signatures went unchecked.
func (p Provenance) AuthMocked() bool { return p.AuthMode != "enforce" }

// Style decides colour.
type Style struct{ Color bool }

// StyleFor colours only a terminal, and never when NO_COLOR is set
// (https://no-color.org).
func StyleFor(w io.Writer) Style {
	if os.Getenv("NO_COLOR") != "" {
		return Style{}
	}
	f, ok := w.(*os.File)
	if !ok {
		return Style{}
	}
	info, err := f.Stat()
	return Style{Color: err == nil && info.Mode()&os.ModeCharDevice != 0}
}

func (s Style) paint(code, text string) string {
	if !s.Color {
		return text
	}
	return "\x1b[" + code + "m" + text + "\x1b[0m"
}

func (s Style) green(t string) string  { return s.paint("32", t) }
func (s Style) yellow(t string) string { return s.paint("33", t) }
func (s Style) red(t string) string    { return s.paint("31", t) }
func (s Style) dim(t string) string    { return s.paint("2", t) }

// Classify says which of the three meanings a returned call has: a read
// (nothing written, no auth) or a write preview.
func Classify(writes, readWrite int, signers []Signer) Kind {
	if writes == 0 && readWrite == 0 && len(signers) == 0 {
		return Read
	}
	return WritePreview
}

// Render writes the call and its provenance footer.
func Render(w io.Writer, c Call, p Provenance, now time.Time, s Style) error {
	var lines []string
	switch c.Kind {
	case Read:
		lines = append(lines, s.green("→ ")+value(c.Value))
	case WritePreview:
		head := fmt.Sprintf("Would write %d %s", c.Writes, plural(c.Writes, "entry", "entries"))
		if len(c.Signers) > 0 {
			who := make([]string, len(c.Signers))
			for i, a := range c.Signers {
				fn := a.Function
				if fn == "" {
					fn = c.Function
				}
				who[i] = fmt.Sprintf("%s (%s)", shorten(a.Address), fn)
			}
			head += " · requires auth from " + strings.Join(who, ", ")
		}
		lines = append(lines, s.yellow(head))
		if v := value(c.Value); v != "(nothing)" {
			lines = append(lines, s.green("→ ")+v)
		}
		lines = append(lines, fmt.Sprintf("Local sandbox: nothing was submitted to %s", p.Network))
	case ContractError:
		// The contract refusing is the contract working: say what it said.
		line := "✗ " + c.Error.Name
		if c.Error.Code != 0 || c.Error.Name != "" {
			line = fmt.Sprintf("✗ %s (#%d)", c.Error.Name, c.Error.Code)
		}
		if c.Error.Doc != "" {
			line += ": " + c.Error.Doc
		}
		lines = append(lines, s.yellow(line))
	case HostError:
		lines = append(lines, s.red(fmt.Sprintf("✗ host error: %s %s", c.Error.HostType, c.Error.HostCode)),
			hostHint(c.Error.HostType))
	case SimulatorError:
		lines = append(lines, s.red("simulator error: "+c.Failure),
			"The sandbox itself failed; this says nothing about the contract.")
	case Timeout:
		lines = append(lines, s.red("timed out: "+c.Failure),
			"The call may be looping. Raise --timeout if it is only slow.")
	}
	if p.AuthMocked() && (c.Kind == WritePreview || c.Kind == Read) {
		lines = append(lines, s.yellow("⚠ auth mocked: signatures were not checked"))
	}
	lines = append(lines, s.dim(Footer(p, now)))
	_, err := io.WriteString(w, strings.Join(lines, "\n")+"\n")
	return err
}

// Footer is the provenance line every result ends with.
func Footer(p Provenance, now time.Time) string {
	parts := []string{
		p.Network,
		fmt.Sprintf("fork ledger %d (%s)", p.ForkLedger, Ago(now.Sub(p.ForkTime))),
		fmt.Sprintf("protocol %d lane", p.Protocol),
	}
	if p.Drift > 0 {
		parts = append(parts, fmt.Sprintf("%d drifted %s", p.Drift, plural(p.Drift, "entry", "entries")))
	} else {
		parts = append(parts, "no drift")
	}
	if len(p.Overrides) > 0 {
		parts = append(parts, strings.Join(p.Overrides, ", "))
	}
	switch p.AuthMode {
	case "enforce":
		parts = append(parts, "auth enforced")
	case "strict":
		parts = append(parts, "auth mocked (strict)")
	default:
		parts = append(parts, "auth mocked")
	}
	return "ran against " + strings.Join(parts, " · ")
}

func hostHint(hostType string) string {
	switch hostType {
	case "Budget":
		return "The call ran out of budget, as it would on the network."
	case "Storage":
		return "The host could not read or write an entry (missing, or archived and needing a restore)."
	case "WasmVm":
		return "The contract trapped (a panic, an unreachable, or a bad memory access)."
	case "Auth":
		return "Authorization failed."
	}
	return "The host refused the call, as the network would."
}

func value(v string) string {
	if v == "" || v == "null" {
		return "(nothing)"
	}
	return v
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func shorten(s string) string {
	if len(s) <= 8 {
		return s
	}
	return s[:4] + "…" + s[len(s)-3:]
}

// Ago is a duration as "3s ago", "2h ago".
func Ago(d time.Duration) string {
	switch {
	case d < time.Second:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
