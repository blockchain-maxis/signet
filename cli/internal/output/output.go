// Package output is the one place the CLI decides what goes to stdout and what
// goes to stderr.
//
// The rules it enforces, for every command:
//
//   - With --json, stdout carries exactly one JSON object, or nothing at all.
//     A CI pipeline can always parse stdout; it never has to strip progress
//     lines, prompts or a half-written result.
//   - Human-readable output goes to stdout; diagnostics (progress in JSON mode,
//     prompts in JSON mode, warnings) go to stderr.
//   - An error writes nothing to stdout. Errors are returned to main, which
//     prints them to stderr and picks the exit code.
package output

import (
	"encoding/json"
	"errors"
	"io"
)

// ErrAlreadyWritten is returned when a command tries to emit a second result.
// It is a programming error, surfaced loudly rather than producing two JSON
// objects a consumer cannot parse.
var ErrAlreadyWritten = errors.New("output: a result was already written")

// Printer writes a command's output. Build one per invocation.
type Printer struct {
	// JSON selects machine-readable output.
	JSON bool
	// Out is stdout; Err is stderr.
	Out io.Writer
	Err io.Writer

	wrote bool
}

// Result emits the command's single result: v as one JSON object in JSON mode,
// otherwise whatever human writes to stdout.
//
// It may be called at most once per Printer. In JSON mode the object is encoded
// before anything reaches stdout, so an encoding failure leaves stdout empty.
func (p *Printer) Result(v any, human func(io.Writer) error) error {
	if p.wrote {
		return ErrAlreadyWritten
	}
	if p.JSON {
		encoded, err := json.Marshal(v)
		if err != nil {
			return err
		}
		p.wrote = true
		_, err = p.Out.Write(append(encoded, '\n'))
		return err
	}
	p.wrote = true
	if human == nil {
		return nil
	}
	return human(p.Out)
}

// Progress reports something happening on the way to a result. In human mode it
// goes to stdout; in JSON mode it goes to stderr so it cannot corrupt the
// object a script is parsing.
func (p *Printer) Progress(msg string) {
	_, _ = io.WriteString(p.Interactive(), msg+"\n") // best-effort
}

// Interactive is where prompts and menus go: stdout for a person at a
// terminal, stderr when stdout is reserved for JSON.
func (p *Printer) Interactive() io.Writer {
	if p.JSON {
		return p.Err
	}
	return p.Out
}

// Diagnostic writes a line to stderr in either mode.
func (p *Printer) Diagnostic(msg string) {
	_, _ = io.WriteString(p.Err, msg+"\n") // best-effort
}

// Wrote reports whether a result has been emitted.
func (p *Printer) Wrote() bool { return p.wrote }
