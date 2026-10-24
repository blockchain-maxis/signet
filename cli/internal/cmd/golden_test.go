package cmd

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/keys"
)

// update rewrites the golden files from the current output instead of
// comparing against them:
//
//	go test ./internal/cmd -update
//
// Review the resulting diff like any other change — that is the point.
var update = flag.Bool("update", false, "rewrite testdata/golden/*.golden with the current output")

// goldenVersion is the build version golden runs pass to the root. The
// normaliser replaces it, so a release never touches a golden file.
const goldenVersion = "0.0.0-golden"

// volatile matches the parts of an output that change from run to run or
// machine to machine. Each is replaced with a stable placeholder here, in the
// helper, so the golden files hold only what a reviewer should care about.
var volatile = []struct {
	pattern *regexp.Regexp
	with    string
}{
	// httptest servers and the loopback callback listen on a random port,
	// printed plainly or query-escaped inside the approval URL.
	{regexp.MustCompile(`127\.0\.0\.1(:|%3A)\d+`), "127.0.0.1${1}<port>"},
	// The loopback callback's state is a fresh random value every run.
	{regexp.MustCompile(`callback_state=[A-Za-z0-9_\-]+`), "callback_state=<state>"},
	// RFC 3339 timestamps, as an expiry or a recorded time.
	{regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})`), "<timestamp>"},
}

// normalizeGolden makes output comparable across runs and operating systems:
// Windows line endings, temp directories, versions and the volatile patterns
// above all become fixed text.
func normalizeGolden(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	for _, dir := range tempDirs() {
		s = strings.ReplaceAll(s, dir, "<tmp>")
	}
	s = strings.ReplaceAll(s, goldenVersion, "<version>")
	s = strings.ReplaceAll(s, keys.MinimumStellarVersion, "<stellar-version>")
	for _, v := range volatile {
		s = v.pattern.ReplaceAllString(s, v.with)
	}
	return s
}

// tempDirs is every spelling of the OS temp directory a path in the output
// might use: as reported, with forward slashes, and with symlinks resolved
// (macOS reports /var/folders/… for what is really /private/var/folders/…).
// Longest first, so a resolved path is not half-replaced by a shorter one.
func tempDirs() []string {
	base := filepath.Clean(os.TempDir())
	dirs := []string{base, filepath.ToSlash(base)}
	if resolved, err := filepath.EvalSymlinks(base); err == nil && resolved != base {
		dirs = append([]string{resolved, filepath.ToSlash(resolved)}, dirs...)
	}
	return dirs
}

// assertGolden compares got, normalised, with testdata/golden/<name>.golden,
// and fails with a line diff when they differ. With -update it writes the file
// instead.
func assertGolden(t *testing.T, name, got string) {
	t.Helper()
	got = normalizeGolden(got)
	path := filepath.Join("testdata", "golden", name+".golden")

	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("creating golden directory: %v", err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatalf("writing %s: %v", path, err)
		}
		return
	}

	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		t.Fatalf("%s does not exist; run `go test ./internal/cmd -update` to create it", path)
	}
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	// A checkout with core.autocrlf can hand Windows CRLF files despite
	// .gitattributes; what is compared is the text, not the line endings.
	want := strings.ReplaceAll(string(raw), "\r\n", "\n")
	if got != want {
		t.Errorf("output differs from %s (- golden, + got); if the change is deliberate, run `go test ./internal/cmd -update`:\n%s",
			path, lineDiff(want, got))
	}
}

// lineDiff renders the difference between want and got line by line, from
// their longest common subsequence: "-" for a line only in want, "+" for one
// only in got, and two lines of unchanged context around each change.
func lineDiff(want, got string) string {
	a, b := strings.Split(want, "\n"), strings.Split(got, "\n")

	// lcs[i][j] is the length of the longest common subsequence of a[i:] and b[j:].
	lcs := make([][]int, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}

	type line struct {
		op   byte
		text string
	}
	var lines []line
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		switch {
		case i < len(a) && j < len(b) && a[i] == b[j]:
			lines = append(lines, line{' ', a[i]})
			i, j = i+1, j+1
		case i < len(a) && (j == len(b) || lcs[i+1][j] >= lcs[i][j+1]):
			lines = append(lines, line{'-', a[i]})
			i++
		default:
			lines = append(lines, line{'+', b[j]})
			j++
		}
	}

	const context = 2
	var out strings.Builder
	last := -1
	for k, l := range lines {
		near := false
		for d := max(0, k-context); d <= min(len(lines)-1, k+context); d++ {
			if lines[d].op != ' ' {
				near = true
				break
			}
		}
		if !near {
			continue
		}
		if last >= 0 && k > last+1 {
			out.WriteString("  …\n")
		}
		fmt.Fprintf(&out, "%c %s\n", l.op, l.text)
		last = k
	}
	return out.String()
}

func TestLineDiffShowsOnlyTheChangeAndItsContext(t *testing.T) {
	want := "a\nb\nc\nd\ne\nf\ng\n"
	got := "a\nb\nc\nD\ne\nf\ng\n"
	diff := lineDiff(want, got)
	for _, line := range []string{"- d\n", "+ D\n", "  c\n", "  e\n"} {
		if !strings.Contains(diff, line) {
			t.Errorf("diff lacks %q:\n%s", line, diff)
		}
	}
	if strings.Contains(diff, "  a\n") {
		t.Errorf("diff shows a line three away from the change:\n%s", diff)
	}
}

func TestNormalizeGoldenHidesVolatileParts(t *testing.T) {
	in := "signet " + goldenVersion + "\r\n" +
		"http://127.0.0.1:54321/link?callback=http%3A%2F%2F127.0.0.1%3A60000%2Fcallback&callback_state=Zk9_x-1\r\n" +
		"expires at 2026-10-23T09:15:00Z\r\n" +
		filepath.Join(os.TempDir(), "TestX", "001") + "\n"
	want := "signet <version>\n" +
		"http://127.0.0.1:<port>/link?callback=http%3A%2F%2F127.0.0.1%3A<port>%2Fcallback&callback_state=<state>\n" +
		"expires at <timestamp>\n" +
		filepath.Join("<tmp>", "TestX", "001") + "\n"
	if got := normalizeGolden(in); got != want {
		t.Fatalf("normalizeGolden =\n%q\nwant\n%q", got, want)
	}
}
