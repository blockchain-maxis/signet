package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
)

func TestUnlinkTakesNoArguments(t *testing.T) {
	cmd := newUnlinkCmd()
	cmd.SetArgs([]string{"GABC"})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})

	if err := cmd.Execute(); err == nil {
		t.Fatal("unlink accepted a positional argument")
	}
}

func TestUnlinkFlags(t *testing.T) {
	cmd := newUnlinkCmd()
	for _, name := range []string{"yes", "json"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Fatalf("--%s is missing", name)
		}
	}
}

func TestConfirmUnlink_OnlyAnExplicitYesCounts(t *testing.T) {
	// #261 requires a confirmation before acting. A prompt that treats a
	// stray newline, or anything it doesn't understand, as consent is not a
	// confirmation — this is destructive.
	yes := []string{"y\n", "Y\n", "yes\n", "YES\n", "  yes  \n"}
	no := []string{"\n", "n\n", "no\n", "maybe\n", "yeah\n", "yy\n", ""}

	for _, in := range yes {
		out := &bytes.Buffer{}
		ok, err := confirmUnlink(strings.NewReader(in), out, "GABC", "")
		if err != nil {
			t.Fatalf("confirmUnlink(%q): %v", in, err)
		}
		if !ok {
			t.Fatalf("confirmUnlink(%q) = false, want true", in)
		}
	}
	for _, in := range no {
		out := &bytes.Buffer{}
		ok, err := confirmUnlink(strings.NewReader(in), out, "GABC", "")
		if err != nil {
			t.Fatalf("confirmUnlink(%q): %v", in, err)
		}
		if ok {
			t.Fatalf("confirmUnlink(%q) = true, want false", in)
		}
	}
}

func TestConfirmUnlink_ShowsTheKeyItIsAbout(t *testing.T) {
	// The identity may not be the one the developer expected, so the prompt
	// names the key rather than asking about "your wallet".
	out := &bytes.Buffer{}
	if _, err := confirmUnlink(strings.NewReader("n\n"), out, "GTHEKEY", ""); err != nil {
		t.Fatalf("confirmUnlink: %v", err)
	}
	if !strings.Contains(out.String(), "GTHEKEY") {
		t.Fatalf("prompt did not name the key: %q", out.String())
	}
}

// fakeDeployment answers GET /api/cli/whoami with the given identity and
// counts every request by path, so a test can assert what unlink did (and
// did not) ask for.
func fakeDeployment(t *testing.T, identity pair.Identity) (*httptest.Server, *requestLog) {
	t.Helper()
	log := &requestLog{byPath: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.record(r.URL.Path)
		if r.URL.Path == "/api/cli/whoami" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(identity)
			return
		}
		http.Error(w, "unexpected request", http.StatusTeapot)
	}))
	t.Cleanup(srv.Close)
	return srv, log
}

type requestLog struct {
	mu     sync.Mutex
	byPath map[string]int
	total  int
}

func (l *requestLog) record(path string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.byPath[path]++
	l.total++
}

func (l *requestLog) snapshot() (map[string]int, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	copied := make(map[string]int, len(l.byPath))
	for k, v := range l.byPath {
		copied[k] = v
	}
	return copied, l.total
}

// runUnlink runs `signet unlink` against srv as the fake stellar's "alice",
// with stdin as given, and returns its output and error.
func runUnlink(t *testing.T, srv *httptest.Server, stdin string, extra ...string) (string, error) {
	t.Helper()
	root := newRootCmd("dev", "none")
	out := &bytes.Buffer{}
	root.SetOut(out)
	root.SetErr(out)
	root.SetIn(strings.NewReader(stdin))
	root.SetArgs(append([]string{"unlink", "--url", srv.URL, "--source", "alice"}, extra...))
	err := root.Execute()
	return out.String(), err
}

// pretendStdinIsATerminal makes unlink treat the test's stdin as interactive.
func pretendStdinIsATerminal(t *testing.T) {
	t.Helper()
	prev := stdinIsTerminal
	stdinIsTerminal = func(io.Reader) bool { return true }
	t.Cleanup(func() { stdinIsTerminal = prev })
}

const aliceKey = "GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD"

func TestUnlink_NonInteractiveWithoutYesExits2BeforeAnyRequest(t *testing.T) {
	// #606: in CI, reading end of input as "no" exited 0 and the pipeline
	// believed the unlink had happened.
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	srv, log := fakeDeployment(t, pair.Identity{PublicKey: aliceKey, Handle: "alice", Linked: true})

	_, err := runUnlink(t, srv, "")
	if err == nil {
		t.Fatal("non-interactive unlink without --yes succeeded")
	}
	if code := ExitCode(err); code != exitcode.InvalidInput {
		t.Fatalf("exit code = %d, want %d (%v)", code, exitcode.InvalidInput, err)
	}
	if !strings.Contains(err.Error(), "unlink needs --yes when not run interactively") {
		t.Fatalf("error = %q", err)
	}
	if _, total := log.snapshot(); total != 0 {
		t.Fatalf("made %d HTTP request(s) before refusing", total)
	}
}

func TestUnlink_NotLinkedExits0WithoutSigning(t *testing.T) {
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	srv, log := fakeDeployment(t, pair.Identity{PublicKey: aliceKey, Linked: false})

	// --yes, so nothing but the not-linked answer stops it. The fake stellar
	// cannot sign at all, so reaching `stellar tx sign` would fail this run.
	out, err := runUnlink(t, srv, "", "--yes")
	if err != nil {
		t.Fatalf("unlink of a not-linked key returned an error: %v\n%s", err, out)
	}
	if !strings.Contains(out, "is not linked") {
		t.Fatalf("output does not say the key is not linked: %q", out)
	}
	byPath, total := log.snapshot()
	if total != 1 || byPath["/api/cli/whoami"] != 1 {
		t.Fatalf("requests = %v, want only one whoami (no challenge fetched)", byPath)
	}
}

func TestUnlink_PromptNamesTheHandle(t *testing.T) {
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	pretendStdinIsATerminal(t)
	srv, log := fakeDeployment(t, pair.Identity{PublicKey: aliceKey, Handle: "alice", Linked: true})

	out, err := runUnlink(t, srv, "n\n")
	if err != nil {
		t.Fatalf("declined unlink returned an error: %v\n%s", err, out)
	}
	if want := "Unlink " + aliceKey + " from @alice? [y/N]"; !strings.Contains(out, want) {
		t.Fatalf("prompt = %q, want it to contain %q", out, want)
	}
	if byPath, _ := log.snapshot(); byPath["/api/auth/sep10"] != 0 {
		t.Fatalf("fetched a challenge after the developer said no: %v", byPath)
	}
}
