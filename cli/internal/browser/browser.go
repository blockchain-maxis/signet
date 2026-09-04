// Package browser opens a URL in the developer's default browser for
// approval flows that need a human in a browser tab — falling back to
// printing the URL for the developer to open manually when that's not
// possible. Go has no stdlib opener, so this is an explicit per-OS shell-out
// (xdg-open, open, rundll32) rather than a dependency.
package browser

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
)

// currentGOOS and getenv are runtime.GOOS/os.Getenv by default; tests
// override them to exercise every platform branch regardless of which OS is
// actually running the test.
var (
	currentGOOS = runtime.GOOS
	getenv      = os.Getenv
)

// openerCommand returns the argv for goos's platform URL opener. url is
// always its own argv element — never interpolated into a shell string — so
// there is no command-injection surface regardless of what it contains.
func openerCommand(goos, url string) []string {
	switch goos {
	case "darwin":
		return []string{"open", url}
	case "windows":
		// rundll32's url.dll entry point is the documented, dependency-free way
		// to hand a URL to the default browser on Windows without invoking a
		// shell (unlike `cmd /c start`, which needs one).
		return []string{"rundll32", "url.dll,FileProtocolHandler", url}
	default: // linux and other freedesktop-ish systems
		return []string{"xdg-open", url}
	}
}

// hasDisplay reports whether this process looks like it can plausibly open a
// GUI browser. Best-effort, and only a meaningful question on GOOS where
// "headless" is possible (Linux/BSD over SSH or in a container) — darwin and
// windows are assumed to always have one. DISPLAY and WAYLAND_DISPLAY are the
// two standard ways an X11 or Wayland session advertises itself.
func hasDisplay(goos string, getenv func(string) string) bool {
	switch goos {
	case "darwin", "windows":
		return true
	default:
		return getenv("DISPLAY") != "" || getenv("WAYLAND_DISPLAY") != ""
	}
}

// run execs the platform opener; swapped out in tests.
var run = func(argv []string) error {
	return exec.Command(argv[0], argv[1:]...).Run() //nolint:gosec // argv[0] is one of a fixed, hardcoded set from openerCommand; url is its own arg, never shell-interpolated.
}

// OpenOrPrint attempts to open url in the developer's default browser, and
// falls back to printing it to out instead — never treating the opener's
// failure as fatal — when noBrowser is set, when no display is detected, or
// when the platform opener itself fails to launch. Both paths reach the
// developer at exactly the same URL; the only difference is who opens it.
//
// The only error OpenOrPrint can return is a failure to write to out itself
// (broken pipe or similar) — the platform opener's own failure is exactly
// the condition this function exists to absorb, never to propagate.
func OpenOrPrint(out io.Writer, url string, noBrowser bool) error {
	if !noBrowser && hasDisplay(currentGOOS, getenv) {
		if err := run(openerCommand(currentGOOS, url)); err == nil {
			return nil
		}
	}
	_, err := fmt.Fprintf(out, "Open this URL to continue:\n\n  %s\n\n", url)
	return err
}
