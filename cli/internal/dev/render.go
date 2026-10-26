package dev

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// Frame is what one save produced, for the terminal (#637): a cycle, or a
// build that failed while an earlier one stays active.
type Frame struct {
	// Build is how long the build took, failed or not; 0 when the cycle
	// replays the current build again.
	Build time.Duration
	// Cycle is nil when the build failed.
	Cycle *Cycle
	// BuildError is the compiler's output when the build failed.
	BuildError string
	// Active is the hash of the build still in use after a failed one; ""
	// when none built yet.
	Active string
}

// RenderOptions are how a frame is printed.
type RenderOptions struct {
	// TTY colours the marks and, with Clear, clears the screen first. Off,
	// the output is plain and append-only.
	TTY   bool
	Clear bool
	// Verbose prints every difference of every item, and the timing.
	Verbose bool
	// FailOnLowFidelity counts a low-fidelity real replay like any other
	// ([replay] fail_on_low_fidelity).
	FailOnLowFidelity bool
}

const (
	clearScreen = "\x1b[H\x1b[2J"
	green       = "\x1b[32m"
	red         = "\x1b[31m"
	yellow      = "\x1b[33m"
	dim         = "\x1b[2m"
	reset       = "\x1b[0m"
)

// groups are the order items are listed in: failed expectations, then by
// their worst difference, then the real replays that did not behave as
// they did on-chain.
var groups = []string{"expected", simulator.ClassBreaking, simulator.ClassBehavioural, simulator.ClassCost, simulator.ClassIgnored, "low-fidelity"}

// Difference is one line of a replay's diff, and its class.
type Difference struct {
	Class string `json:"class"`
	Text  string `json:"text"`
}

// item is one replay as the terminal shows it.
type item struct {
	outcome Outcome
	group   string
	diffs   []Difference
}

// Render prints a frame: a summary line that answers "did I break
// anything?", the interface and storage layout findings, then one line per
// replay with differences, grouped (breaking first), its first difference
// inline. Verbose adds every difference and the time by phase.
func Render(f Frame, o RenderOptions) string {
	var b strings.Builder
	if o.TTY && o.Clear {
		b.WriteString(clearScreen)
	}
	paint := func(colour, s string) string {
		if !o.TTY {
			return s
		}
		return colour + s + reset
	}
	if f.Cycle == nil {
		active := "no build is active yet"
		if f.Active != "" {
			active = shortHash(f.Active) + " (the previous build) is still active"
		}
		fmt.Fprintf(&b, "%s build failed in %s · %s\n", paint(red, "✗"), duration(f.Build), active)
		for _, line := range strings.Split(strings.TrimRight(f.BuildError, "\n"), "\n") {
			b.WriteString("  " + line + "\n")
		}
		return b.String()
	}
	c := f.Cycle

	items := make([]item, len(c.Outcomes))
	counts := map[string]int{}
	saved, real := 0, 0
	for i, out := range c.Outcomes {
		it := item{outcome: out, diffs: Differences(out)}
		if out.Real != nil {
			real++
		} else {
			saved++
		}
		it.group = Group(out, it.diffs, o.FailOnLowFidelity)
		if it.group != "" {
			counts[it.group]++
		}
		items[i] = it
	}

	mark := paint(green, "✓")
	if counts["expected"]+counts[simulator.ClassBreaking] > 0 {
		mark = paint(red, "✗")
	}
	parts := []string{"build " + duration(f.Build)}
	if f.Build == 0 {
		parts = []string{"same build"}
	}
	if c.Timing.Install > 0 {
		parts = append(parts, "install "+duration(c.Timing.Install))
	}
	parts = append(parts, "swap "+duration(c.Timing.Swap))
	replays := fmt.Sprintf("%d saved", saved)
	if real > 0 {
		replays += fmt.Sprintf(" + %d real", real)
	}
	parts = append(parts, fmt.Sprintf("%s %s %s", replays, pluralWord(saved+real, "replay", "replays"), duration(c.Timing.Replays())))
	if n := counts["expected"]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d %s", n, pluralWord(n, "expectation failed", "expectations failed")))
	}
	parts = append(parts, fmt.Sprintf("%d breaking", counts[simulator.ClassBreaking]))
	if n := counts[simulator.ClassBehavioural]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d behavioural", n))
	}
	parts = append(parts, fmt.Sprintf("%d cost", counts[simulator.ClassCost]), fmt.Sprintf("%d ignored", counts[simulator.ClassIgnored]))
	if n := counts["low-fidelity"]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d low-fidelity", n))
	}
	for _, reason := range c.Restarted {
		parts = append(parts, fmt.Sprintf("simulator restarted (%s)", reason))
	}
	fmt.Fprintf(&b, "%s %s\n", mark, strings.Join(parts, " · "))
	if o.Verbose {
		fmt.Fprintf(&b, "  %s (deployed) → %s (build) · time: install %s, swap %s, A %s, B %s, diff %s\n",
			shortHash(c.Deployed), shortHash(c.Local), duration(c.Timing.Install), duration(c.Timing.Swap),
			duration(c.Timing.A), duration(c.Timing.B), duration(c.Timing.Diff))
	}

	if s := c.Spec; s != nil && len(s.Changes) > 0 {
		fmt.Fprintf(&b, "  interface: %d breaking, %d compatible, %d info\n", s.Summary.Breaking, s.Summary.Compatible, s.Summary.Info)
		for _, ch := range s.Changes {
			if ch.Class == simulator.ClassBreaking || o.Verbose {
				fmt.Fprintf(&b, "    %s %s\n", ch.Kind, ch.Path)
			}
		}
	}
	if l := c.Layout; l != nil && len(l.Findings) > 0 {
		fmt.Fprintf(&b, "  storage layout: %d stored %s the build cannot read\n", len(l.Findings), pluralWord(len(l.Findings), "value", "values"))
		for _, finding := range l.Findings {
			fmt.Fprintf(&b, "    %s %s (%s, %s): %s\n", shortKeys(finding.Key), compact(finding.DecodedKey), finding.UDT, finding.Evidence, finding.Reason)
		}
	}
	if len(c.Outcomes) == 0 {
		b.WriteString("  no replays: save calls with signet sandbox call … --save, or set [replay] recent_transactions\n")
		return b.String()
	}

	width := 0
	for _, it := range items {
		width = max(width, len([]rune(it.outcome.Name)))
	}
	colours := map[string]string{"expected": red, simulator.ClassBreaking: red, simulator.ClassBehavioural: yellow, simulator.ClassCost: "", simulator.ClassIgnored: dim, "low-fidelity": dim}
	listed := false
	for _, g := range groups {
		if g == simulator.ClassIgnored && !o.Verbose {
			continue
		}
		var in []item
		for _, it := range items {
			if it.group == g {
				in = append(in, it)
			}
		}
		if len(in) == 0 {
			continue
		}
		listed = true
		heading := g
		if g == "low-fidelity" && !o.FailOnLowFidelity {
			heading = "low-fidelity (not counted)"
		}
		b.WriteString("  " + paint(colours[g], heading) + "\n")
		for _, it := range in {
			b.WriteString(itemLine(it, width, o.Verbose))
		}
	}
	if !listed {
		b.WriteString("  no differences\n")
	}
	return b.String()
}

// Group is where a replay is listed and counted: "expected" when it missed
// its expect, "low-fidelity" for a real transaction that did not behave as
// on-chain (unless failOnLow), else its worst difference's class; "" when
// it has none.
func Group(o Outcome, diffs []Difference, failOnLow bool) string {
	switch {
	case o.Real != nil && !o.Real.Fidelity.High && !failOnLow:
		return "low-fidelity"
	case o.Verdict != nil && !o.Verdict.Pass:
		return "expected"
	case len(diffs) > 0:
		return diffs[0].Class
	}
	return ""
}

// itemLine is an item's line, and with verbose every difference under it.
func itemLine(it item, width int, verbose bool) string {
	var b strings.Builder
	o := it.outcome
	name := o.Name + strings.Repeat(" ", width-len([]rune(o.Name)))
	var first []string
	if v := o.Verdict; v != nil && !v.Pass {
		first = append(first, fmt.Sprintf("✗ expected %s: %s", v.Expect, v.Reason))
	}
	if len(it.diffs) > 0 && !verbose {
		first = append(first, it.diffs[0].Text)
		if n := len(it.diffs) - 1; n > 0 {
			first = append(first, fmt.Sprintf("(+%d more)", n))
		}
	}
	if r := o.Real; r != nil && !r.Fidelity.High {
		first = append(first, "· "+r.Fidelity.Reason)
	}
	if len(first) == 0 && len(it.diffs) == 0 {
		first = append(first, "no differences")
	}
	fmt.Fprintf(&b, "%s\n", strings.TrimRight("    "+name+"  "+strings.Join(first, "  "), " "))
	if !verbose {
		return b.String()
	}
	if r := o.Real; r != nil && r.Link != "" {
		fmt.Fprintf(&b, "      %s\n", r.Link)
	}
	for _, d := range it.diffs {
		fmt.Fprintf(&b, "      %-11s %s\n", d.Class, d.Text)
	}
	if o.Diff != nil {
		b.WriteString(storageTable(o.Diff.Storage))
		b.WriteString(resourceTable(o.Diff.Resources))
		for _, a := range append(append([]simulator.AuthChange{}, o.Diff.Auth.Added...), o.Diff.Auth.Removed...) {
			if len(a.Invocation) > 0 {
				fmt.Fprintf(&b, "      auth tree of %s:\n", shortKeys(a.Signer))
				b.WriteString(authTree(a.Invocation, "        "))
			}
		}
	}
	return b.String()
}

// Differences are a replay's differences, worst class first, in the order
// outcome, return value, events, storage, auth, resources within a class.
func Differences(o Outcome) []Difference {
	d := o.Diff
	if d == nil || d.Empty {
		return nil
	}
	var out []Difference
	add := func(class, format string, args ...any) {
		out = append(out, Difference{class, fmt.Sprintf(format, args...)})
	}
	if x := d.Outcome; x != nil {
		add(x.Class, "return: %s → %s", side(o.A), side(o.B))
	}
	if x := d.ReturnValue; x != nil {
		add(x.Class, "return%s: %s", at(&x.Path), change(x.A, x.B))
	}
	for _, e := range d.Events.Added {
		add(e.Class, "event added: %s", topics(e.Topics))
	}
	for _, e := range d.Events.Removed {
		add(e.Class, "event removed: %s", topics(e.Topics))
	}
	for _, e := range d.Events.Changed {
		add(e.Class, "event %d%s: %s", e.Index, at(e.Path), change(e.A, e.B))
	}
	for _, s := range d.Storage.Added {
		add(s.Class, "storage added: %s", shortKeys(s.Key))
	}
	for _, s := range d.Storage.Removed {
		add(s.Class, "storage removed: %s", shortKeys(s.Key))
	}
	for _, s := range d.Storage.Changed {
		add(s.Class, "storage %s%s: %s", shortKeys(s.Key), at(s.Path), change(s.A, s.B))
	}
	for _, s := range d.Storage.TTL {
		add(s.Class, "ttl %s: %s → %s", shortKeys(s.Key), compact(s.A), compact(s.B))
	}
	for _, a := range d.Auth.Added {
		add(a.Class, "auth: %s now signs", shortKeys(a.Signer))
	}
	for _, a := range d.Auth.Removed {
		add(a.Class, "auth: %s no longer signs", shortKeys(a.Signer))
	}
	for _, a := range d.Auth.Changed {
		add(a.Class, "auth %s%s: %s", shortKeys(a.Signer), at(a.Path), change(a.A, a.B))
	}
	// The resources are one line per class: "instructions +2%, fee +0.6%".
	byClass := map[string][]string{}
	var classes []string
	for _, r := range d.Resources {
		if _, ok := byClass[r.Class]; !ok {
			classes = append(classes, r.Class)
		}
		byClass[r.Class] = append(byClass[r.Class], resource(r))
	}
	for _, class := range classes {
		add(class, "resources: %s", strings.Join(byClass[class], ", "))
	}
	rank := func(class string) int {
		if i := slices.Index(groups, class); i >= 0 {
			return i
		}
		return len(groups)
	}
	slices.SortStableFunc(out, func(a, b Difference) int { return rank(a.Class) - rank(b.Class) })
	return out
}

// side is what a run ended in: Ok(1), Err(HandleTaken).
func side(r Run) string {
	switch {
	case r.Error != nil && r.Error.Decoded != nil && r.Error.Decoded.ErrorName != "":
		return "Err(" + r.Error.Decoded.ErrorName + ")"
	case r.Error != nil:
		return "Err(" + r.Error.Code + ")"
	case r.Result == nil:
		return "?"
	case len(r.Result.ReturnValue) == 0 || string(r.Result.ReturnValue) == "null":
		return "Ok(())"
	}
	return "Ok(" + shortKeys(clip(compact(r.Result.ReturnValue))) + ")"
}

// change is "a → b", with the types when the values print alike.
func change(a, b json.RawMessage) string {
	x, y := value(a), value(b)
	if x == y {
		x, y = typed(a), typed(b)
	}
	return x + " → " + y
}

func at(path *string) string {
	if path == nil || *path == "" {
		return ""
	}
	return " " + *path
}

// resource is one metric's move: "instructions +2% (282,900 → 288,561)".
func resource(r simulator.ResourceChange) string {
	sign := "+"
	if r.Delta < 0 {
		sign = ""
	}
	change := sign + thousands(r.Delta)
	if r.Percent != nil {
		change = percent(*r.Percent)
	}
	return fmt.Sprintf("%s %s (%s → %s)", r.Metric, change, thousands(r.A), thousands(r.B))
}

func storageTable(s simulator.DiffStorage) string {
	if len(s.Added)+len(s.Removed)+len(s.Changed) == 0 {
		return ""
	}
	var buf bytes.Buffer
	tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "storage\tbefore\tafter")
	for _, c := range s.Added {
		_, _ = fmt.Fprintf(tw, "%s\t-\t%s\n", shortKeys(c.Key), entryValue(c.Entry))
	}
	for _, c := range s.Removed {
		_, _ = fmt.Fprintf(tw, "%s\t%s\t-\n", shortKeys(c.Key), entryValue(c.Entry))
	}
	for _, c := range s.Changed {
		x, y := value(c.A), value(c.B)
		if x == y {
			x, y = typed(c.A), typed(c.B)
		}
		_, _ = fmt.Fprintf(tw, "%s%s\t%s\t%s\n", shortKeys(c.Key), at(c.Path), x, y)
	}
	_ = tw.Flush()
	return indent(buf.String(), "      ")
}

func resourceTable(rs []simulator.ResourceChange) string {
	if len(rs) == 0 {
		return ""
	}
	var buf bytes.Buffer
	tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "resource\tA\tB\tdelta")
	for _, r := range rs {
		delta := thousands(r.Delta)
		if r.Delta > 0 {
			delta = "+" + delta
		}
		if r.Percent != nil {
			delta += " (" + percent(*r.Percent) + ")"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.Metric, thousands(r.A), thousands(r.B), delta)
	}
	_ = tw.Flush()
	return indent(buf.String(), "      ")
}

// indent puts prefix before every line of s.
func indent(s, prefix string) string {
	lines := strings.SplitAfter(s, "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = prefix + l
		}
	}
	return strings.Join(lines, "")
}

// authTree prints an authorized invocation and what it calls in turn.
func authTree(raw json.RawMessage, indent string) string {
	var inv struct {
		ContractID string            `json:"contract_id"`
		Function   string            `json:"function"`
		Args       []json.RawMessage `json:"args"`
		Sub        []json.RawMessage `json:"sub_invocations"`
	}
	if json.Unmarshal(raw, &inv) != nil {
		return indent + compact(raw) + "\n"
	}
	args := make([]string, len(inv.Args))
	for i, a := range inv.Args {
		args[i] = value(a)
	}
	out := fmt.Sprintf("%s%s.%s(%s)\n", indent, shortKeys(inv.ContractID), inv.Function, strings.Join(args, ", "))
	for _, s := range inv.Sub {
		out += authTree(s, indent+"  ")
	}
	return out
}

func topics(ts []json.RawMessage) string {
	if len(ts) == 0 {
		return "(no topics)"
	}
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = value(t)
	}
	return strings.Join(out, ", ")
}

// entryValue is a ledger entry's stored value.
func entryValue(raw json.RawMessage) string {
	var e struct {
		Value json.RawMessage `json:"value"`
	}
	if json.Unmarshal(raw, &e) != nil || len(e.Value) == 0 || string(e.Value) == "null" {
		return "()"
	}
	return value(e.Value)
}

// value is a tagged value ({"type": "u32", "value": 1}) as text: 1. An
// address is shortened, a string quoted, void is ().
func value(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "-"
	}
	var tagged struct {
		Type  *string         `json:"type"`
		Value json.RawMessage `json:"value"`
	}
	if json.Unmarshal(raw, &tagged) != nil || tagged.Type == nil {
		return shortKeys(clip(compact(raw)))
	}
	switch *tagged.Type {
	case "void":
		return "()"
	case "string":
		return clip(compact(tagged.Value))
	}
	var s string
	if json.Unmarshal(tagged.Value, &s) == nil {
		return shortKeys(clip(s))
	}
	return shortKeys(clip(compact(tagged.Value)))
}

// typed is value with its type, for two values that print alike.
func typed(raw json.RawMessage) string {
	var tagged struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(raw, &tagged)
	if tagged.Type == "" {
		return value(raw)
	}
	return value(raw) + " (" + tagged.Type + ")"
}

func compact(raw json.RawMessage) string {
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		return string(raw)
	}
	return buf.String()
}

func clip(s string) string {
	if r := []rune(s); len(r) > 60 {
		return string(r[:59]) + "…"
	}
	return s
}

var strkey = regexp.MustCompile(`\b[GC][A-Z2-7]{55}\b`)

// shortKeys shortens the account and contract ids in s: GA5Z…KZVN.
func shortKeys(s string) string {
	return strkey.ReplaceAllStringFunc(s, func(k string) string { return k[:4] + "…" + k[52:] })
}

// duration is a phase's time: 4ms, 180ms, 2.1s.
func duration(d time.Duration) string {
	switch {
	case d <= 0:
		return "0ms"
	case d < time.Millisecond:
		return "<1ms"
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1fs", d.Seconds())
}

func thousands(n int64) string {
	s := fmt.Sprint(n)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	if neg {
		return "-" + s
	}
	return s
}

// percent is a signed change to one decimal: +2%, -0.6%, -<0.1%.
func percent(p float64) string {
	sign := "+"
	if p < 0 {
		sign, p = "-", -p
	}
	if p < 0.05 {
		return sign + "<0.1%"
	}
	return sign + trimFloat(p) + "%"
}

func trimFloat(f float64) string {
	return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.1f", f), "0"), ".")
}

func shortHash(h string) string {
	if len(h) > 8 {
		return h[:8]
	}
	return h
}

func pluralWord(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
