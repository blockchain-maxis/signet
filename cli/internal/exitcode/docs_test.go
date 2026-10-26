package exitcode

import (
	"bufio"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The exit-code taxonomy is documented three times — cli/README.md,
// docs/CLI.md and docs/SANDBOX.md each carry an "Exit codes" table — and #528's acceptance is that neither
// can drift from sentinelCodes: this test parses both tables and compares
// the code sets against the source of truth. Codes 0–2 (OK, Generic,
// InvalidInput) are documented but deliberately outside the sentinel table
// (see the comment on InvalidInput), so they are asserted separately.

var tableRow = regexp.MustCompile("^\\|\\s*`(\\d+)`\\s*\\|")

// exitCodeTable returns the codes listed in the "Exit codes" markdown table
// of the file at path, in order of appearance.
func exitCodeTable(t *testing.T, path string) []int {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = f.Close() }()

	var codes []int
	inSection := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "#") {
			inSection = strings.Contains(line, "Exit codes")
			continue
		}
		if !inSection {
			continue
		}
		if m := tableRow.FindStringSubmatch(line); m != nil {
			n, err := strconv.Atoi(m[1])
			if err != nil {
				t.Fatalf("%s: unparsable code in row %q", path, line)
			}
			codes = append(codes, n)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if len(codes) == 0 {
		t.Fatalf("%s: found no Exit codes table rows — heading renamed?", path)
	}
	return codes
}

func TestDocsTablesMatchSentinelCodes(t *testing.T) {
	// Paths relative to this package's directory, where `go test` runs.
	docs := map[string][]int{
		"../../README.md":      exitCodeTable(t, "../../README.md"),
		"../../../docs/CLI.md": exitCodeTable(t, "../../../docs/CLI.md"),
		// The sandbox guide's troubleshooting table (#642).
		"../../../docs/SANDBOX.md": exitCodeTable(t, "../../../docs/SANDBOX.md"),
	}

	want := map[int]bool{OK: true, Generic: true, InvalidInput: true}
	for _, s := range sentinelCodes {
		want[s.code] = true
	}

	for path, codes := range docs {
		got := map[int]bool{}
		for _, c := range codes {
			if got[c] {
				t.Errorf("%s: code %d documented twice", path, c)
			}
			got[c] = true
		}
		for c := range want {
			if !got[c] {
				t.Errorf("%s: code %d is in the taxonomy but missing from the table", path, c)
			}
		}
		for c := range got {
			if !want[c] {
				t.Errorf("%s: code %d is documented but not in the taxonomy", path, c)
			}
		}
	}

	// The two tables must also agree with each other row-for-row.
	readme := docs["../../README.md"]
	cli := docs["../../../docs/CLI.md"]
	if len(readme) != len(cli) {
		t.Fatalf("tables disagree: cli/README.md has %d rows, docs/CLI.md has %d", len(readme), len(cli))
	}
	for i := range readme {
		if readme[i] != cli[i] {
			t.Errorf("row %d: cli/README.md says %d, docs/CLI.md says %d", i, readme[i], cli[i])
		}
	}
}
