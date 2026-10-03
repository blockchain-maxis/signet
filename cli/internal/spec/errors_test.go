package spec

import (
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// Every generated failure code maps to a sentinel, and none falls through to
// Generic — a code added to cli-api.ts without a line in errors.go fails here
// rather than surfacing as exit 1 in someone's CI.
func TestEveryFailureCodeMapsToASentinel(t *testing.T) {
	for _, code := range CliFailureCodes {
		err, ok := ErrorFor(code)
		if !ok || err == nil {
			t.Errorf("failure code %q has no entry in failureErrors", code)
			continue
		}
		if got, known := exitcode.CodeFor(err); !known || got == exitcode.Generic {
			t.Errorf("failure code %q maps to exit %d, which is Generic", code, got)
		}
	}
	if len(failureErrors) != len(CliFailureCodes) {
		t.Errorf("failureErrors has %d entries for %d codes — one is stale", len(failureErrors), len(CliFailureCodes))
	}
}

// Each route's own failure union has to be part of CliFailureCode, or a route
// could send a code the table above has never heard of.
func TestEveryRouteFailureIsACliFailureCode(t *testing.T) {
	known := map[string]bool{}
	for _, c := range CliFailureCodes {
		known[string(c)] = true
	}
	groups := map[string][]string{}
	add := func(name string, values ...string) { groups[name] = values }
	add("RequestFailure", strs(RequestFailures)...)
	add("StartFailure", strs(StartFailures)...)
	add("PollFailure", strs(PollFailures)...)
	add("ApproveFailure", strs(ApproveFailures)...)
	add("RejectFailure", strs(RejectFailures)...)
	add("CompleteFailure", strs(CompleteFailures)...)
	add("UnlinkFailure", strs(UnlinkFailures)...)
	add("CliLinkFailure", strs(CliLinkFailures)...)

	for group, values := range groups {
		for _, v := range values {
			if !known[v] {
				t.Errorf("%s value %q is not a CliFailureCode", group, v)
			}
		}
	}
}

func TestTheCodesAScriptBranchesOn(t *testing.T) {
	cases := map[CliFailureCode]int{
		CliFailureCodeWalletBoundElsewhere: exitcode.AlreadyLinked,
		CliFailureCodeAlreadyCompleted:     exitcode.AlreadyLinked,
		CliFailureCodeUnavailable:          exitcode.Configuration,
		CliFailureCodeBadChallenge:         exitcode.Network,
	}
	for code, want := range cases {
		err, _ := ErrorFor(code)
		if got, _ := exitcode.CodeFor(err); got != want {
			t.Errorf("%q → exit %d, want %d", code, got, want)
		}
	}
	if _, ok := ErrorFor("not-a-real-code"); ok {
		t.Error("an unknown code must report ok=false so the caller falls back to the status")
	}
}

func strs[T ~string](values []T) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = string(v)
	}
	return out
}
