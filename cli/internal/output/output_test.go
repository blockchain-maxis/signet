package output

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func newPrinter(json bool) (*Printer, *bytes.Buffer, *bytes.Buffer) {
	out, err := &bytes.Buffer{}, &bytes.Buffer{}
	return &Printer{JSON: json, Out: out, Err: err}, out, err
}

func TestResult_JSONWritesExactlyOneObject(t *testing.T) {
	p, out, errBuf := newPrinter(true)
	humanCalled := false

	err := p.Result(map[string]string{"status": "linked"}, func(io.Writer) error {
		humanCalled = true
		return nil
	})
	if err != nil {
		t.Fatalf("Result: %v", err)
	}
	if got := out.String(); got != "{\"status\":\"linked\"}\n" {
		t.Fatalf("stdout = %q, want one JSON object and a newline", got)
	}
	if humanCalled {
		t.Fatal("the human renderer ran in JSON mode")
	}
	if errBuf.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", errBuf.String())
	}
}

func TestResult_HumanModeRunsTheRendererAndNeverEmitsJSON(t *testing.T) {
	p, out, _ := newPrinter(false)

	err := p.Result(map[string]string{"status": "linked"}, func(w io.Writer) error {
		_, err := io.WriteString(w, "Linked.\n")
		return err
	})
	if err != nil {
		t.Fatalf("Result: %v", err)
	}
	if out.String() != "Linked.\n" {
		t.Fatalf("stdout = %q, want the human text", out.String())
	}
}

func TestResult_SecondResultIsRefused(t *testing.T) {
	for _, json := range []bool{true, false} {
		p, out, _ := newPrinter(json)
		if err := p.Result(1, nil); err != nil {
			t.Fatalf("first Result: %v", err)
		}
		before := out.String()

		if err := p.Result(2, nil); !errors.Is(err, ErrAlreadyWritten) {
			t.Fatalf("json=%v: second Result err = %v, want ErrAlreadyWritten", json, err)
		}
		if out.String() != before {
			t.Fatalf("json=%v: a refused second result still wrote %q", json, out.String()[len(before):])
		}
	}
}

func TestResult_AnUnencodableValueLeavesStdoutEmpty(t *testing.T) {
	p, out, _ := newPrinter(true)

	err := p.Result(make(chan int), nil)
	if err == nil {
		t.Fatal("Result accepted a value JSON cannot encode")
	}
	if out.Len() != 0 {
		t.Fatalf("stdout = %q, want empty after an encoding failure", out.String())
	}
	if p.Wrote() {
		t.Fatal("a failed encode counted as a written result")
	}
}

func TestResult_HumanRendererErrorIsReturned(t *testing.T) {
	p, _, _ := newPrinter(false)
	want := errors.New("boom")
	if err := p.Result(nil, func(io.Writer) error { return want }); !errors.Is(err, want) {
		t.Fatalf("err = %v, want the renderer's error", err)
	}
}

func TestProgress_GoesToStdoutForHumansAndStderrForJSON(t *testing.T) {
	human, hOut, hErr := newPrinter(false)
	human.Progress("Waiting for approval…")
	if hOut.String() != "Waiting for approval…\n" || hErr.Len() != 0 {
		t.Fatalf("human progress: stdout=%q stderr=%q", hOut.String(), hErr.String())
	}

	machine, mOut, mErr := newPrinter(true)
	machine.Progress("Waiting for approval…")
	if mOut.Len() != 0 {
		t.Fatalf("JSON progress reached stdout: %q", mOut.String())
	}
	if !strings.Contains(mErr.String(), "Waiting for approval…") {
		t.Fatalf("JSON progress missing from stderr: %q", mErr.String())
	}
}

func TestInteractive_FollowsTheSameRule(t *testing.T) {
	human, hOut, _ := newPrinter(false)
	_, _ = io.WriteString(human.Interactive(), "Select one: ")
	if hOut.String() != "Select one: " {
		t.Fatalf("human prompt stdout = %q", hOut.String())
	}

	machine, mOut, mErr := newPrinter(true)
	_, _ = io.WriteString(machine.Interactive(), "Select one: ")
	if mOut.Len() != 0 || mErr.String() != "Select one: " {
		t.Fatalf("JSON prompt: stdout=%q stderr=%q", mOut.String(), mErr.String())
	}
}

func TestDiagnostic_AlwaysStderr(t *testing.T) {
	for _, json := range []bool{true, false} {
		p, out, errBuf := newPrinter(json)
		p.Diagnostic("warning: something")
		if out.Len() != 0 || errBuf.String() != "warning: something\n" {
			t.Fatalf("json=%v: stdout=%q stderr=%q", json, out.String(), errBuf.String())
		}
	}
}
