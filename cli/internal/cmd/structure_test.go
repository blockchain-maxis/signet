package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// newTestRoot builds the real command tree with Deps that cannot reach the
// outside world: the `stellar` binary does not exist and the deployment URL is
// a closed local port.
func newTestRoot(t *testing.T) (root *cobra.Command, stdout, stderr *bytes.Buffer) {
	t.Helper()
	isolateConfigDir(t)
	deps := defaultDeps()
	deps.KeysBinary = "/nonexistent/signet-test-stellar"
	root = newRootCmdWithDeps("test", "abc1234", deps)
	stdout, stderr = &bytes.Buffer{}, &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetIn(strings.NewReader(""))
	return root, stdout, stderr
}

// topLevelCommands returns every command directly under the root, including
// cobra's built-in help and completion.
func topLevelCommands(t *testing.T) []*cobra.Command {
	t.Helper()
	root, _, _ := newTestRoot(t)
	root.InitDefaultHelpCmd()
	root.InitDefaultCompletionCmd()
	return root.Commands()
}

// assertInheritsJSON fails unless the named command accepts the root's
// persistent --json flag.
func assertInheritsJSON(t *testing.T, name string) {
	t.Helper()
	root, _, _ := newTestRoot(t)
	sub, _, err := root.Find([]string{name})
	if err != nil || sub == nil || sub.Name() != name {
		t.Fatalf("command %q not found: %v", name, err)
	}
	if sub.InheritedFlags().Lookup("json") == nil {
		t.Fatalf("%s does not inherit --json from the root", name)
	}
	if sub.LocalFlags().Lookup("json") != nil {
		t.Fatalf("%s declares its own --json; the root's persistent flag is the only definition", name)
	}
}

func knownGroup(id string) bool {
	for _, g := range groupOrder {
		if g.id == id {
			return true
		}
	}
	return false
}

func TestEveryRegisteredCommandBelongsToAGroup(t *testing.T) {
	for _, r := range registrations {
		if !knownGroup(r.group.id) {
			t.Errorf("a command registered under unknown group %q", r.group.id)
		}
	}

	for _, c := range topLevelCommands(t) {
		if c.GroupID == "" {
			t.Errorf("command %q has no group; register it with register(group, constructor)", c.Name())
			continue
		}
		if !knownGroup(c.GroupID) {
			t.Errorf("command %q is in unknown group %q", c.Name(), c.GroupID)
		}
	}
}

func TestExistingCommandsLandInTheirGroups(t *testing.T) {
	want := map[string]string{
		"link":       groupIdentity.id,
		"unlink":     groupIdentity.id,
		"whoami":     groupIdentity.id,
		"identity":   groupIdentity.id,
		"version":    groupOther.id,
		"help":       groupOther.id,
		"completion": groupOther.id,
	}
	got := map[string]string{}
	for _, c := range topLevelCommands(t) {
		got[c.Name()] = c.GroupID
	}
	for name, group := range want {
		if got[name] != group {
			t.Errorf("%s is in group %q, want %q", name, got[name], group)
		}
	}
}

func TestHelpListsTheGroupsInOrder(t *testing.T) {
	root, stdout, _ := newTestRoot(t)
	root.SetArgs([]string{"--help"})
	if err := root.Execute(); err != nil {
		t.Fatalf("--help: %v", err)
	}
	help := stdout.String()

	// Only groups that have a command are shown, in groupOrder's order.
	populated := map[string]bool{groupOther.id: true}
	for _, r := range registrations {
		populated[r.group.id] = true
	}

	last := -1
	for _, g := range groupOrder {
		idx := strings.Index(help, g.title)
		if !populated[g.id] {
			if idx != -1 {
				t.Errorf("empty group %q is listed in --help", g.title)
			}
			continue
		}
		if idx == -1 {
			t.Errorf("--help does not list the group %q:\n%s", g.title, help)
			continue
		}
		if idx < last {
			t.Errorf("group %q is listed out of order:\n%s", g.title, help)
		}
		last = idx
	}

	// The identity commands sit under the Identity heading, before Other's.
	identityAt := strings.Index(help, groupIdentity.title)
	otherAt := strings.Index(help, groupOther.title)
	for _, name := range []string{"link", "unlink", "whoami", "identity"} {
		at := strings.Index(help, "\n  "+name+" ")
		if at < identityAt || at > otherAt {
			t.Errorf("%s is not listed under %q:\n%s", name, groupIdentity.title, help)
		}
	}
	for _, name := range []string{"completion", "version"} {
		if at := strings.Index(help, "\n  "+name+" "); at < otherAt {
			t.Errorf("%s is not listed under %q:\n%s", name, groupOther.title, help)
		}
	}
}

func TestJSONFlagIsPersistentOnTheRootOnly(t *testing.T) {
	root, _, _ := newTestRoot(t)
	if root.PersistentFlags().Lookup("json") == nil {
		t.Fatal("root has no persistent --json flag")
	}
	for _, name := range []string{"link", "unlink", "whoami"} {
		assertInheritsJSON(t, name)
	}
}

// runtimeFailure is an invocation that gets past flag parsing and fails inside
// the command (the `stellar` binary is missing), which is where a half-written
// result would come from.
var runtimeFailure = []string{"--source", "alice", "--url", "http://127.0.0.1:1"}

// failing lists, for each command that can fail while running, the arguments
// that make it do so. A command that cannot fail at run time is listed in
// cannotFail instead. A new command must appear in one of them, so its author
// has to decide - and the JSON-on-error rule below then covers it.
var failing = map[string][]string{
	"link":     append([]string{"link", "--json"}, runtimeFailure...),
	"unlink":   append([]string{"unlink", "--json", "--yes"}, runtimeFailure...),
	"whoami":   append([]string{"whoami", "--json"}, runtimeFailure...),
	"identity": append([]string{"identity", "--json"}, runtimeFailure...),
}

var cannotFail = map[string]bool{"version": true, "help": true, "completion": true}

func TestEveryCommandIsCoveredByTheJSONErrorRule(t *testing.T) {
	for _, c := range topLevelCommands(t) {
		_, isFailing := failing[c.Name()]
		if !isFailing && !cannotFail[c.Name()] {
			t.Errorf("command %q is in neither `failing` nor `cannotFail`; add it so the --json error rule covers it", c.Name())
		}
	}
}

func TestJSONModeWritesNothingToStdoutOnError(t *testing.T) {
	// Runtime failures.
	for name, args := range failing {
		t.Run(name+"/runtime", func(t *testing.T) {
			root, stdout, _ := newTestRoot(t)
			root.SetArgs(args)
			if err := root.Execute(); err == nil {
				t.Fatalf("%v succeeded; the test needs an invocation that fails", args)
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout = %q after an error under --json, want nothing", stdout.String())
			}
		})
	}

	// Every command, including the ones that cannot fail at run time, must
	// also keep stdout empty when it is refused for a bad flag.
	for _, c := range topLevelCommands(t) {
		name := c.Name()
		t.Run(name+"/bad-flag", func(t *testing.T) {
			root, stdout, _ := newTestRoot(t)
			root.SetArgs([]string{name, "--json", "--definitely-not-a-flag"})
			if err := root.Execute(); err == nil {
				t.Fatal("an unknown flag was accepted")
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout = %q after a rejected flag under --json, want nothing", stdout.String())
			}
		})
	}
}

func TestJSONModeWritesExactlyOneObjectOnSuccess(t *testing.T) {
	root, stdout, stderr := newTestRoot(t)
	root.SetArgs([]string{"version", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatalf("version --json: %v", err)
	}

	dec := json.NewDecoder(stdout)
	var got versionResult
	if err := dec.Decode(&got); err != nil {
		t.Fatalf("stdout is not a JSON object: %v", err)
	}
	if dec.More() {
		t.Fatalf("stdout carries more than one JSON value: %q", stdout.String())
	}
	if got.Version != "test" || got.Commit != "abc1234" {
		t.Fatalf("version --json = %+v", got)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestVersionHumanOutputMatchesTheFlag(t *testing.T) {
	root, stdout, _ := newTestRoot(t)
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatalf("version: %v", err)
	}
	if got, want := stdout.String(), "signet version test (commit abc1234)\n"; got != want {
		t.Fatalf("version = %q, want %q", got, want)
	}
}

func TestCommandsReadFakesFromDeps(t *testing.T) {
	// The point of Deps: a command reaches `stellar` only through
	// Deps.KeysBinary, so a test can substitute one. With a binary that does
	// not exist, `identity` must fail rather than fall back to the real one.
	root, stdout, _ := newTestRoot(t)
	root.SetArgs([]string{"identity", "--source", "alice"})
	if err := root.Execute(); err == nil {
		t.Fatal("identity succeeded with a nonexistent stellar binary")
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q, want nothing", stdout.String())
	}
}

func TestDepsForFailsWithoutTheRoot(t *testing.T) {
	standalone := &cobra.Command{Use: "x"}
	standalone.SetContext(context.Background())
	if _, err := depsFor(standalone); err == nil {
		t.Fatal("depsFor succeeded on a command the root never set up")
	}
}
