package simulator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// placeExecutable writes a file that passes isExecutableFile at dir/name.
func placeExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLocate(t *testing.T) {
	root := t.TempDir()
	envBin := placeExecutable(t, filepath.Join(root, "env"), BinaryName())
	cliDir := filepath.Join(root, "install")
	cliExe := placeExecutable(t, cliDir, "signet")
	sibling := placeExecutable(t, cliDir, BinaryName())
	onPath := placeExecutable(t, filepath.Join(root, "path"), BinaryName())
	bareCLI := placeExecutable(t, filepath.Join(root, "bare"), "signet")
	notExecutable := filepath.Join(root, "plain.txt")
	if err := os.WriteFile(notExecutable, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	pathHit := func(string) (string, error) { return onPath, nil }
	pathMiss := func(string) (string, error) { return "", errors.New("not on PATH") }

	type locateCase struct {
		name   string
		env    string
		exe    string
		look   func(string) (string, error)
		want   string
		errHas string
	}
	cases := []locateCase{
		{name: "env var", env: envBin, exe: cliExe, look: pathHit, want: envBin},
		{name: "env var wins over a sibling", env: envBin, exe: cliExe, look: pathMiss, want: envBin},
		{name: "sibling of the CLI", exe: cliExe, look: pathHit, want: sibling},
		{name: "PATH", exe: bareCLI, look: pathHit, want: onPath},
		{name: "nowhere", exe: bareCLI, look: pathMiss, errHas: "contract simulator not found — reinstall signet-cli or set `SIGNET_SIMULATOR_PATH`"},
		{name: "env var names a missing file", env: filepath.Join(root, "missing"), exe: cliExe, look: pathHit, errHas: "SIGNET_SIMULATOR_PATH is set to"},
	}
	if runtime.GOOS != "windows" {
		cases = append(cases, locateCase{name: "env var names a non-executable file", env: notExecutable, exe: cliExe, look: pathHit, errHas: "not an executable file"})
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := locator{
				getenv: func(k string) string {
					if k == PathEnv {
						return tc.env
					}
					return ""
				},
				executable: func() (string, error) { return tc.exe, nil },
				lookPath:   tc.look,
			}
			got, err := l.locate()
			if tc.errHas != "" {
				if err == nil || !strings.Contains(err.Error(), tc.errHas) {
					t.Fatalf("err = %v, want it to mention %q", err, tc.errHas)
				}
				if !errors.Is(err, ErrSimulatorNotFound) {
					t.Fatalf("should be ErrSimulatorNotFound: %v", err)
				}
				if code, _ := exitcode.CodeFor(err); code != exitcode.Configuration {
					t.Fatalf("exit code %d, want %d", code, exitcode.Configuration)
				}
				return
			}
			if err != nil {
				t.Fatalf("locate: %v", err)
			}
			if got != tc.want {
				t.Fatalf("locate = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestLocateFollowsASymlinkedCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	// Resolve the temp dir itself first: on macOS it lives under /var, a
	// symlink to /private/var, and the lookup resolves links.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	real := placeExecutable(t, filepath.Join(root, "cellar"), "signet")
	sibling := placeExecutable(t, filepath.Join(root, "cellar"), BinaryName())
	link := filepath.Join(root, "bin", "signet")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	l := locator{
		getenv:     func(string) string { return "" },
		executable: func() (string, error) { return link, nil },
		lookPath:   func(string) (string, error) { return "", errors.New("no") },
	}
	got, err := l.locate()
	if err != nil || got != sibling {
		t.Fatalf("locate = %q, %v; want %q", got, err, sibling)
	}
}

func TestErrSimulatorNotFoundMessage(t *testing.T) {
	want := "contract simulator not found — reinstall signet-cli or set `SIGNET_SIMULATOR_PATH`"
	if ErrSimulatorNotFound.Error() != want {
		t.Fatalf("message = %q", ErrSimulatorNotFound)
	}
	if !errors.Is(ErrSimulatorNotFound, exitcode.ErrConfiguration) {
		t.Fatal("must wrap exitcode.ErrConfiguration")
	}
}

func TestVersionWarning(t *testing.T) {
	bin := buildFake(t)
	ctx := context.Background()

	t.Setenv("FAKESIM_VERSION", "0.4.0")
	if w := VersionWarning(ctx, bin, "v0.4.0"); w != "" {
		t.Fatalf("matching versions warned: %q", w)
	}
	if w := VersionWarning(ctx, bin, "dev"); w != "" {
		t.Fatalf("a dev CLI warned: %q", w)
	}
	w := VersionWarning(ctx, bin, "0.5.1")
	if !strings.Contains(w, "signet-simulator 0.4.0") || !strings.Contains(w, "signet 0.5.1") {
		t.Fatalf("mismatch warning should name both versions: %q", w)
	}

	if v, err := Version(ctx, bin); err != nil || v != "0.4.0" {
		t.Fatalf("Version = %q, %v", v, err)
	}
	if w := VersionWarning(ctx, filepath.Join(t.TempDir(), "gone"), "0.5.1"); !strings.Contains(w, "could not read") {
		t.Fatalf("an unreadable version should warn, not fail: %q", w)
	}
}

func TestFindUsesTheEnvironmentAndWarns(t *testing.T) {
	bin := buildFake(t)
	t.Setenv(PathEnv, bin)
	t.Setenv("FAKESIM_VERSION", "0.1.0")
	var warned []string
	got, err := Find(context.Background(), "0.2.0", func(s string) { warned = append(warned, s) })
	if err != nil {
		t.Fatalf("Find: %v", err)
	}
	if abs, _ := filepath.Abs(bin); got != abs {
		t.Fatalf("Find = %q, want %q", got, abs)
	}
	if len(warned) != 1 {
		t.Fatalf("warnings = %v, want one", warned)
	}
}
