package keys

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeStellarPath is set by TestMain to the compiled fakestellar binary,
// built once into a directory that outlives every individual test — a plain
// t.TempDir() is torn down when the *first* calling test returns, but every
// test in this file needs the same binary.
var fakeStellarPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakestellar")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)

	name := "fakestellar"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	fakeStellarPath = filepath.Join(dir, name)

	build := exec.Command("go", "build", "-o", fakeStellarPath, "./testdata/fakestellar")
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		panic("building fakestellar: " + err.Error())
	}

	os.Exit(m.Run())
}

func TestExecRunner_CapturesStdout(t *testing.T) {
	r := ExecRunner{Bin: fakeStellarPath}
	out, err := r.Run(context.Background(), "keys", "ls")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(out, "alice") || !strings.Contains(out, "bob") {
		t.Fatalf("got %q", out)
	}
}

func TestExecRunner_NonZeroExitSurfacesStderr(t *testing.T) {
	r := ExecRunner{Bin: fakeStellarPath}
	_, err := r.Run(context.Background(), "keys", "public-key", "nobody")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), `no identity called "nobody" found`) {
		t.Fatalf("error %q did not surface stellar's own stderr", err.Error())
	}
}

func TestExecRunner_EndToEndPublicKey(t *testing.T) {
	r := ExecRunner{Bin: fakeStellarPath}
	pk, err := PublicKey(context.Background(), r, "alice")
	if err != nil {
		t.Fatalf("PublicKey: %v", err)
	}
	if pk != "GA7YI536V4BC7CL43DRMZ2UU7N4T3VZZSY7FVOY6Q4JUPBVZYHN43QMT" {
		t.Fatalf("got %q", pk)
	}
}
