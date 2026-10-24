package simulator

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// buildFake compiles testdata/fakesimulator once per test binary run, the
// same helper-binary pattern as internal/keys' fakestellar. The directory is
// a plain MkdirTemp, removed in TestMain, because t.TempDir() would vanish
// with the first test that asked for it.
var (
	fakeOnce sync.Once
	fakeDir  string
	fakePath string
	fakeErr  error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if fakeDir != "" {
		_ = os.RemoveAll(fakeDir)
	}
	if code == 0 {
		if leaked := leakedGoroutines(5 * time.Second); leaked != "" {
			fmt.Fprintf(os.Stderr, "goroutines leaked by internal/simulator:\n%s\n", leaked)
			code = 1
		}
	}
	os.Exit(code)
}

// leakedGoroutines waits up to d for every goroutine started by this
// package's non-test code to finish, and returns the stacks of any that did
// not. It is the check go.uber.org/goleak would make, without the
// dependency.
func leakedGoroutines(d time.Duration) string {
	deadline := time.Now().Add(d)
	for {
		buf := make([]byte, 1<<20)
		buf = buf[:runtime.Stack(buf, true)]
		var leaked []string
		for _, g := range strings.Split(string(buf), "\n\n") {
			if strings.Contains(g, "internal/simulator.") &&
				!strings.Contains(g, "simulator.TestMain") &&
				!strings.Contains(g, "simulator.leakedGoroutines") {
				leaked = append(leaked, g)
			}
		}
		if len(leaked) == 0 {
			return ""
		}
		if time.Now().After(deadline) {
			return strings.Join(leaked, "\n\n")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func buildFake(t *testing.T) string {
	t.Helper()
	fakeOnce.Do(func() {
		goBin, err := exec.LookPath("go")
		if err != nil {
			fakeErr = err
			return
		}
		dir, err := os.MkdirTemp("", "fakesimulator")
		if err != nil {
			fakeErr = err
			return
		}
		fakeDir = dir
		out := filepath.Join(dir, "signet-simulator")
		if runtime.GOOS == "windows" {
			out += ".exe"
		}
		cmd := exec.Command(goBin, "build", "-o", out, "./testdata/fakesimulator")
		if output, buildErr := cmd.CombinedOutput(); buildErr != nil {
			fakeErr = fmt.Errorf("%w: %s", buildErr, output)
			return
		}
		fakePath = out
	})
	if fakeErr != nil {
		t.Skipf("could not build the fake simulator: %v", fakeErr)
	}
	return fakePath
}

func transcript(name string) string {
	return filepath.Join("..", "..", "..", "sandbox", "protocol", "transcripts", name+".ndjson")
}
