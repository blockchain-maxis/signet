package cmd

import (
	"encoding/json"
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/jsonschema"
)

// counterContract is counter_v1 as the fake RPC serves it deployed
// (generate-calls.mjs).
func counterContract(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(registryTestdata, "calls-getLedgerEntries.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Contracts map[string]string `json:"contracts"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f.Contracts["counter_v1"]
}

// ciRun is one signet dev --ci over the deployed counter, with build as the
// new code (a fixture WASM name, or "fail" for a compile error).
type ciRun struct {
	code   int
	report map[string]any
	junit  junitSuites
	stdout string
}

func runCounterCI(t *testing.T, e *callEnv, root, dir, build string, extra ...string) ciRun {
	t.Helper()
	t.Setenv("FAKESTELLAR_BUILD", "")
	if build == "fail" {
		t.Setenv("FAKESTELLAR_BUILD", "fail")
	} else {
		wasm := filepath.Join(root, "sandbox", "fixtures", "wasm", build+".wasm")
		t.Setenv("FAKESTELLAR_BUILD_WASM", wasm)
	}
	report, junit := filepath.Join(dir, build+"-report.json"), filepath.Join(dir, build+"-junit.xml")
	args := append([]string{"dev", "--rpc-url", e.rpc.srv.URL, "--ci", "--report", report, "--junit", junit}, extra...)
	stdout, stderr, err := e.cli(args...)
	run := ciRun{code: ExitCode(err), stdout: stdout}
	raw, rerr := os.ReadFile(report)
	if rerr != nil {
		t.Fatalf("no report (%v): %v\n%s\n%s", err, rerr, stdout, stderr)
	}
	if err := json.Unmarshal(raw, &run.report); err != nil {
		t.Fatal(err)
	}
	schema, err := jsonschema.Load(filepath.Join(root, "sandbox", "protocol", "schema", "v1", "ci-report.json"))
	if err != nil {
		t.Fatal(err)
	}
	if errs := jsonschema.Validate(schema, schema, run.report); len(errs) > 0 {
		t.Fatalf("the report does not match ci-report.json: %s", strings.Join(errs, "\n"))
	}
	raw, err = os.ReadFile(junit)
	if err != nil {
		t.Fatal(err)
	}
	if err := xml.Unmarshal(raw, &run.junit); err != nil {
		t.Fatalf("junit: %v\n%s", err, raw)
	}
	if run.report["exit_code"] != float64(run.code) {
		t.Fatalf("the report says exit %v, the command exited %d", run.report["exit_code"], run.code)
	}
	return run
}

// failures are the failing testcases, as suite/name.
func (r ciRun) failures() []string {
	var out []string
	for _, s := range r.junit.Suites {
		for _, c := range s.Cases {
			if c.Failure != nil {
				out = append(out, s.Name+"/"+c.Name+": "+c.Failure.Message)
			}
		}
	}
	return out
}

// The acceptance test of #639.
func TestDevCIExitsWithACodeAPipelineCanBranchOn(t *testing.T) {
	e := newCallEnv(t)
	devTools(t)
	e.stellar = "stellar"
	crate := devCrate(t)
	dir := t.TempDir()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	toml := "version = 1\naddress = \"" + counterContract(t) + "\"\npath = \"" + filepath.ToSlash(crate) + "\"\n" +
		"\n[[call]]\nname = \"get\"\nfunction = \"get\"\nargs = {}\nexpect = \"any\"\n" +
		"\n[[call]]\nname = \"increment\"\nfunction = \"increment\"\nargs = {}\nexpect = \"any\"\n"
	if err := os.WriteFile(filepath.Join(dir, "signet.dev.toml"), []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)

	clean := runCounterCI(t, e, root, dir, "counter_v1")
	if clean.code != exitcode.OK || clean.report["result"] != "clean" || clean.junit.Tests != 2 || clean.junit.Failures != 0 {
		t.Fatalf("a clean run: exit %d, %v, junit %d tests %d failures\n%s", clean.code, clean.report["result"], clean.junit.Tests, clean.junit.Failures, clean.stdout)
	}
	if !strings.Contains(clean.report["note"].(string), "live fork") || clean.report["offline"] != false {
		t.Fatalf("a live run says so: %v", clean.report["note"])
	}

	breaking := runCounterCI(t, e, root, dir, "counter_v2_return")
	failed := strings.Join(breaking.failures(), "\n")
	if breaking.code != exitcode.DiffFound || !strings.Contains(failed, "replays/get: return: 0 (u32) → 0 (i128)") ||
		!strings.Contains(failed, "replays/increment: return: 1 (u32) → 1 (i128)") || !strings.Contains(failed, "spec/return-type-changed functions.get.outputs") {
		t.Fatalf("a breaking return change: exit %d\n%s", breaking.code, failed)
	}

	broken := runCounterCI(t, e, root, dir, "fail")
	if broken.code != exitcode.BuildFailed || broken.report["result"] != "build_failed" ||
		len(broken.failures()) != 1 || !strings.HasPrefix(broken.failures()[0], "build/identity-registry: the build failed") {
		t.Fatalf("a build error: exit %d, %v", broken.code, broken.failures())
	}

	// counter_v2_cost costs more on both calls and drops counter_v1's
	// upgrade: only the interface fails --fail-on spec, only the costs
	// --fail-on cost, and nothing --fail-on breaking.
	spec := runCounterCI(t, e, root, dir, "counter_v2_cost", "--fail-on", "spec")
	if spec.code != exitcode.DiffFound || strings.Join(spec.failures(), "\n") != "spec/function-removed functions.upgrade: Removing a function breaks clients that call it." {
		t.Fatalf("--fail-on spec: exit %d, %v", spec.code, spec.failures())
	}
	for _, r := range spec.report["replays"].([]any) {
		if x := r.(map[string]any); x["group"] != "cost" || x["failed"] != false {
			t.Fatalf("--fail-on spec fails a cost difference: %v", x)
		}
	}
	if cost := runCounterCI(t, e, root, dir, "counter_v2_cost", "--fail-on", "cost"); cost.code != exitcode.DiffFound || len(cost.failures()) != 2 {
		t.Fatalf("--fail-on cost: exit %d, %v", cost.code, cost.failures())
	}
	if b := runCounterCI(t, e, root, dir, "counter_v2_cost", "--fail-on", "breaking"); b.code != exitcode.OK {
		t.Fatalf("--fail-on breaking with only cost differences: exit %d, %v", b.code, b.failures())
	}

	if _, _, err := e.cli("dev", "--rpc-url", e.rpc.srv.URL, "--ci", "--fail-on", "speed"); ExitCode(err) != exitcode.InvalidInput {
		t.Fatalf("--fail-on speed: %v", err)
	}
	if _, _, err := e.cli("dev", "--rpc-url", e.rpc.srv.URL, "--report", "r.json"); ExitCode(err) != exitcode.InvalidInput {
		t.Fatalf("--report without --ci: %v", err)
	}
}

// With --bundle nothing touches the network: the RPC is never asked.
func TestDevCIRunsABundleOffline(t *testing.T) {
	e := newCallEnv(t)
	bundlePath := exportRegistrySession(t, e)
	e.rpc.mu.Lock()
	e.rpc.asked = nil
	e.rpc.mu.Unlock()
	report := filepath.Join(t.TempDir(), "report.json")
	stdout, stderr, err := e.cli("dev", "--rpc-url", "http://127.0.0.1:1", "--ci", "--bundle", bundlePath, "--report", report)
	if err != nil {
		t.Fatalf("%v\n%s\n%s", err, stdout, stderr)
	}
	raw, _ := os.ReadFile(report)
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	if got["offline"] != true || got["result"] != "clean" || !strings.Contains(got["note"].(string), "ran offline on repro.json") {
		t.Fatalf("report: %s", raw)
	}
	if len(e.rpc.asked) != 0 {
		t.Fatalf("an offline run fetched %v", e.rpc.asked)
	}
}
