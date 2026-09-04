package browser

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

const testURL = "https://signet.example/cli-link?state=abc123"

func TestOpenerCommandPerPlatform(t *testing.T) {
	cases := []struct {
		goos string
		want []string
	}{
		{"darwin", []string{"open", testURL}},
		{"windows", []string{"rundll32", "url.dll,FileProtocolHandler", testURL}},
		{"linux", []string{"xdg-open", testURL}},
		{"freebsd", []string{"xdg-open", testURL}}, // falls through with other unix-likes
	}
	for _, c := range cases {
		got := openerCommand(c.goos, testURL)
		if len(got) != len(c.want) {
			t.Fatalf("openerCommand(%q) = %v, want %v", c.goos, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("openerCommand(%q) = %v, want %v", c.goos, got, c.want)
			}
		}
	}
}

func TestHasDisplay(t *testing.T) {
	cases := []struct {
		goos string
		env  map[string]string
		want bool
	}{
		{"darwin", nil, true},
		{"windows", nil, true},
		{"linux", nil, false},
		{"linux", map[string]string{"DISPLAY": ":0"}, true},
		{"linux", map[string]string{"WAYLAND_DISPLAY": "wayland-0"}, true},
		{"linux", map[string]string{"DISPLAY": "", "WAYLAND_DISPLAY": ""}, false},
	}
	for _, c := range cases {
		getenv := func(key string) string { return c.env[key] }
		if got := hasDisplay(c.goos, getenv); got != c.want {
			t.Fatalf("hasDisplay(%q, %v) = %v, want %v", c.goos, c.env, got, c.want)
		}
	}
}

// withFakeEnv points currentGOOS/getenv at fixed values for the duration of
// the test, restoring the real runtime.GOOS/os.Getenv afterwards.
func withFakeEnv(t *testing.T, goos string, env map[string]string) {
	t.Helper()
	prevGOOS, prevGetenv := currentGOOS, getenv
	currentGOOS = goos
	getenv = func(key string) string { return env[key] }
	t.Cleanup(func() {
		currentGOOS = prevGOOS
		getenv = prevGetenv
	})
}

func withFakeRun(t *testing.T, fn func(argv []string) error) {
	t.Helper()
	prev := run
	run = fn
	t.Cleanup(func() { run = prev })
}

func TestOpenOrPrintOpensSuccessfullyWithoutPrinting(t *testing.T) {
	withFakeEnv(t, "darwin", nil)
	var gotArgv []string
	withFakeRun(t, func(argv []string) error {
		gotArgv = argv
		return nil
	})

	out := &bytes.Buffer{}
	if err := OpenOrPrint(out, testURL, false); err != nil {
		t.Fatalf("OpenOrPrint: %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("printed a fallback message despite a successful open: %q", out.String())
	}
	if len(gotArgv) == 0 || gotArgv[len(gotArgv)-1] != testURL {
		t.Fatalf("opener was not invoked with the URL: %v", gotArgv)
	}
}

func TestOpenOrPrintFallsBackWhenTheOpenerFails(t *testing.T) {
	withFakeEnv(t, "darwin", nil)
	withFakeRun(t, func(argv []string) error {
		return errors.New("exec: \"open\": executable file not found in $PATH")
	})

	out := &bytes.Buffer{}
	if err := OpenOrPrint(out, testURL, false); err != nil {
		t.Fatalf("OpenOrPrint returned an error — the opener's failure must never be fatal: %v", err)
	}
	if !strings.Contains(out.String(), testURL) {
		t.Fatalf("fallback output does not contain the URL: %q", out.String())
	}
}

func TestOpenOrPrintFallsBackWithNoBrowserFlag(t *testing.T) {
	withFakeEnv(t, "darwin", nil)
	called := false
	withFakeRun(t, func(argv []string) error {
		called = true
		return nil
	})

	out := &bytes.Buffer{}
	if err := OpenOrPrint(out, testURL, true); err != nil {
		t.Fatalf("OpenOrPrint: %v", err)
	}
	if called {
		t.Fatal("the opener was invoked despite --no-browser")
	}
	if !strings.Contains(out.String(), testURL) {
		t.Fatalf("fallback output does not contain the URL: %q", out.String())
	}
}

func TestOpenOrPrintFallsBackWithNoDisplayDetected(t *testing.T) {
	withFakeEnv(t, "linux", nil) // no DISPLAY, no WAYLAND_DISPLAY
	called := false
	withFakeRun(t, func(argv []string) error {
		called = true
		return nil
	})

	out := &bytes.Buffer{}
	if err := OpenOrPrint(out, testURL, false); err != nil {
		t.Fatalf("OpenOrPrint: %v", err)
	}
	if called {
		t.Fatal("the opener was invoked despite no display being detected")
	}
	if !strings.Contains(out.String(), testURL) {
		t.Fatalf("fallback output does not contain the URL: %q", out.String())
	}
}

func TestOpenOrPrintBothPathsReachTheSameURL(t *testing.T) {
	withFakeEnv(t, "linux", map[string]string{"DISPLAY": ":0"})

	// Path 1: opener succeeds — the URL it was launched with.
	var openedWith string
	withFakeRun(t, func(argv []string) error {
		openedWith = argv[len(argv)-1]
		return nil
	})
	if err := OpenOrPrint(&bytes.Buffer{}, testURL, false); err != nil {
		t.Fatalf("OpenOrPrint: %v", err)
	}

	// Path 2: fallback print — the URL printed for the developer.
	printed := &bytes.Buffer{}
	if err := OpenOrPrint(printed, testURL, true); err != nil {
		t.Fatalf("OpenOrPrint: %v", err)
	}

	if openedWith != testURL {
		t.Fatalf("opener path used %q, want %q", openedWith, testURL)
	}
	if !strings.Contains(printed.String(), testURL) {
		t.Fatalf("print path did not contain %q: %q", testURL, printed.String())
	}
}
