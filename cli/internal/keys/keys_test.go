package keys

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeRunner is an in-memory Runner — no process spawn — for exercising the
// parsing/resolution logic in isolation from ExecRunner's os/exec plumbing
// (that plumbing has its own test, in execrunner_test.go).
type fakeRunner struct {
	// responses maps a joined-args key (e.g. "keys ls") to a canned stdout or error.
	responses map[string]string
	errs      map[string]error
	calls     []string
}

func (f *fakeRunner) Run(_ context.Context, args ...string) (string, error) {
	key := strings.Join(args, " ")
	f.calls = append(f.calls, key)
	if err, ok := f.errs[key]; ok {
		return "", err
	}
	return f.responses[key], nil
}

func TestList_ParsesOneNamePerLine(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{"keys ls": "alice\nbob\n\nlandfall-deployer\n"}}
	names, err := List(context.Background(), r)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	want := []string{"alice", "bob", "landfall-deployer"}
	if len(names) != len(want) {
		t.Fatalf("got %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("got %v, want %v", names, want)
		}
	}
}

func TestList_EmptyOutputIsEmptySlice(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{"keys ls": ""}}
	names, err := List(context.Background(), r)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("got %v, want empty", names)
	}
}

func TestList_PropagatesRunnerError(t *testing.T) {
	wantErr := errors.New("stellar not found")
	r := &fakeRunner{errs: map[string]error{"keys ls": wantErr}}
	if _, err := List(context.Background(), r); !errors.Is(err, wantErr) {
		t.Fatalf("got %v, want %v", err, wantErr)
	}
}

func TestPublicKey_ReturnsTrimmedAddress(t *testing.T) {
	pk := "GA7YI536V4BC7CL43DRMZ2UU7N4T3VZZSY7FVOY6Q4JUPBVZYHN43QMT"
	r := &fakeRunner{responses: map[string]string{"keys public-key alice": "  " + pk + "  \n"}}
	got, err := PublicKey(context.Background(), r, "alice")
	if err != nil {
		t.Fatalf("PublicKey: %v", err)
	}
	if got != pk {
		t.Fatalf("got %q, want %q", got, pk)
	}
}

func TestPublicKey_RejectsMalformedOutput(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{"keys public-key alice": "not-a-key"}}
	if _, err := PublicKey(context.Background(), r, "alice"); err == nil {
		t.Fatal("expected an error for malformed output, got nil")
	}
}

func TestResolve_PrefersExplicit(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{"keys ls": "alice\nbob\n"}}
	got, err := Resolve(context.Background(), r, "bob", nil)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != "bob" {
		t.Fatalf("got %q, want %q", got, "bob")
	}
	if len(r.calls) != 0 {
		t.Fatalf("explicit source should skip `stellar keys ls` entirely, but calls = %v", r.calls)
	}
}

func TestResolve_SoleIdentityNeedsNoPrompt(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{"keys ls": "only-one\n"}}
	got, err := Resolve(context.Background(), r, "", func([]string) (string, error) {
		t.Fatal("prompt should not be called when there is exactly one identity")
		return "", nil
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != "only-one" {
		t.Fatalf("got %q, want %q", got, "only-one")
	}
}

func TestResolve_NoIdentitiesIsAClearError(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{"keys ls": ""}}
	_, err := Resolve(context.Background(), r, "", nil)
	if !errors.Is(err, ErrNoIdentities) {
		t.Fatalf("got %v, want ErrNoIdentities", err)
	}
}

func TestResolve_AmbiguousWithoutPromptIsAClearError(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{"keys ls": "alice\nbob\n"}}
	_, err := Resolve(context.Background(), r, "", nil)
	if !errors.Is(err, ErrAmbiguousIdentity) {
		t.Fatalf("got %v, want ErrAmbiguousIdentity", err)
	}
}

func TestResolve_AmbiguousDefersToPrompt(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{"keys ls": "alice\nbob\n"}}
	got, err := Resolve(context.Background(), r, "", func(names []string) (string, error) {
		if len(names) != 2 || names[0] != "alice" || names[1] != "bob" {
			t.Fatalf("prompt got %v", names)
		}
		return "bob", nil
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got != "bob" {
		t.Fatalf("got %q, want %q", got, "bob")
	}
}
