package exitcode

import (
	"errors"
	"fmt"
	"testing"
)

func TestCodeForNilIsOK(t *testing.T) {
	code, ok := CodeFor(nil)
	if !ok || code != OK {
		t.Fatalf("CodeFor(nil) = (%d, %v), want (%d, true)", code, ok, OK)
	}
}

func TestCodeForEachSentinel(t *testing.T) {
	cases := []struct {
		err  error
		code int
	}{
		{ErrConfiguration, Configuration},
		{ErrNoIdentity, NoIdentity},
		{ErrSigningFailure, SigningFailure},
		{ErrNetwork, Network},
		{ErrTimeout, Timeout},
		{ErrApprovalRejected, ApprovalRejected},
		{ErrAlreadyLinked, AlreadyLinked},
	}
	for _, c := range cases {
		code, ok := CodeFor(c.err)
		if !ok {
			t.Fatalf("CodeFor(%v) reported not-a-taxonomy-member, want true", c.err)
		}
		if code != c.code {
			t.Fatalf("CodeFor(%v) = %d, want %d", c.err, code, c.code)
		}
	}
}

func TestCodeForMatchesThroughMultipleWrapLayers(t *testing.T) {
	wrapped := fmt.Errorf("outer: %w", fmt.Errorf("middle: %w", ErrNetwork))
	code, ok := CodeFor(wrapped)
	if !ok || code != Network {
		t.Fatalf("CodeFor(doubly-wrapped ErrNetwork) = (%d, %v), want (%d, true)", code, ok, Network)
	}
	if !errors.Is(wrapped, ErrNetwork) {
		t.Fatal("errors.Is does not see through the wrapping")
	}
}

func TestCodeForAnUnrelatedErrorIsNotAMember(t *testing.T) {
	code, ok := CodeFor(errors.New("something else entirely"))
	if ok {
		t.Fatalf("CodeFor(unrelated error) reported taxonomy membership with code %d, want false", code)
	}
}

func TestSentinelsAreAllDistinctCodes(t *testing.T) {
	seen := map[int]error{}
	for _, s := range sentinelCodes {
		if prior, dup := seen[s.code]; dup {
			t.Fatalf("code %d is shared by %v and %v — every documented code must be unique", s.code, prior, s.err)
		}
		seen[s.code] = s.err
	}
}
