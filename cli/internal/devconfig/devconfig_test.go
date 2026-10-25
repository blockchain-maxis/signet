package devconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"

	"github.com/blockchain-maxis/signet/cli/internal/jsonschema"
)

// docsExample is the signet.dev.toml example in docs/SANDBOX.md.
func docsExample(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "SANDBOX.md"))
	if err != nil {
		t.Fatal(err)
	}
	_, after, ok := strings.Cut(string(raw), "```toml\n")
	if !ok {
		t.Fatal("docs/SANDBOX.md has no ```toml example")
	}
	example, _, _ := strings.Cut(after, "```")
	return []byte(example)
}

func TestTheDocsExampleParsesAndRoundTrips(t *testing.T) {
	f, err := Parse("SANDBOX.md", docsExample(t))
	if err != nil {
		t.Fatal(err)
	}
	if f.Network.Name != "testnet" || len(f.Calls) != 2 || len(f.Overrides) != 1 || *f.Replay.RecentTransactions != 20 {
		t.Fatalf("parsed %+v", f)
	}
	if f.Calls[1].Expect != (Expect{Kind: "error", Error: "HandleTaken"}) || f.Calls[1].Args["handle"] != "alice" {
		t.Fatalf("call 2 = %+v", f.Calls[1])
	}
	again, err := f.Encode()
	if err != nil {
		t.Fatal(err)
	}
	back, err := Parse("encoded", again)
	if err != nil {
		t.Fatalf("%v\n%s", err, again)
	}
	if !reflect.DeepEqual(f, back) {
		t.Fatalf("round trip differs:\n%+v\n%+v\n%s", f, back, again)
	}
}

func TestTheDocsExampleMatchesTheJSONSchema(t *testing.T) {
	schema, err := jsonschema.Load(filepath.Join("..", "..", "..", "sandbox", "protocol", "schema", "v1", "signet-dev-toml.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if _, err := toml.Decode(string(docsExample(t)), &doc); err != nil {
		t.Fatal(err)
	}
	// Through JSON, so TOML integers are the numbers a schema sees.
	raw, _ := json.Marshal(doc)
	var value any
	_ = json.Unmarshal(raw, &value)
	if errs := jsonschema.Validate(schema, schema, value); len(errs) > 0 {
		t.Fatalf("docs example: %s", strings.Join(errs, "\n"))
	}
}

func TestANetworkTableNamesAnRPC(t *testing.T) {
	f, err := Parse("t", []byte("version = 1\n[network]\nrpc_url = \"http://localhost:8000/rpc\"\npassphrase = \"Standalone Network ; February 2017\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	if f.Network.RPCURL != "http://localhost:8000/rpc" || f.Network.Name != "" {
		t.Fatalf("network = %+v", f.Network)
	}
}

func TestUnknownKeysFailWithTheirLines(t *testing.T) {
	_, err := Parse("signet.dev.toml", []byte("version = 1\nadress = \"C\"\n\n[[call]]\nname = \"a\"\nfunction = \"f\"\nexpect = \"ok\"\nexpected = \"ok\"\n\n[replay]\nsaved = true\nrecent = 3\n"))
	var errs Errors
	if !errors.As(err, &errs) {
		t.Fatalf("err = %v", err)
	}
	got := err.Error()
	for _, want := range []string{
		`signet.dev.toml:2: unknown key "adress"`,
		`signet.dev.toml:8: unknown key "call.expected"`,
		`signet.dev.toml:12: unknown key "replay.recent"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("lacks %q:\n%s", want, got)
		}
	}
	var syntax *Error
	if _, err := Parse("bad.toml", []byte("version = 1\n[[call]\n")); !errors.As(err, &syntax) || syntax.Line < 2 || syntax.Msg == "" {
		t.Fatalf("syntax error: %v", err)
	}
}

func TestADuplicateCallNameFails(t *testing.T) {
	_, err := Parse("signet.dev.toml", []byte("version = 1\n[[call]]\nname = \"same\"\nfunction = \"f\"\nexpect = \"ok\"\n[[call]]\nname = \"same\"\nfunction = \"g\"\nexpect = \"any\"\n"))
	if err == nil || !strings.Contains(err.Error(), `signet.dev.toml:7: two calls are named "same"`) {
		t.Fatalf("err = %v", err)
	}
}

func TestEachExpectFormParses(t *testing.T) {
	for in, want := range map[string]Expect{
		"unchanged":          {Kind: "unchanged"},
		"ok":                 {Kind: "ok"},
		"any":                {Kind: "any"},
		"error:HandleTaken":  {Kind: "error", Error: "HandleTaken"},
		"error:Not_Found_42": {Kind: "error", Error: "Not_Found_42"},
	} {
		f, err := Parse("t", []byte(fmt.Sprintf("version = 1\n[[call]]\nname = \"c\"\nfunction = \"f\"\nexpect = %q\n", in)))
		if err != nil || f.Calls[0].Expect != want {
			t.Errorf("%q: %+v %v", in, f, err)
		}
	}
	for _, bad := range []string{"error:", "error:has space", "sometimes", ""} {
		if _, err := Parse("t", []byte(fmt.Sprintf("version = 1\n[[call]]\nname = \"c\"\nfunction = \"f\"\nexpect = %q\n", bad))); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestOtherChecks(t *testing.T) {
	for text, want := range map[string]string{
		"version = 2\n":                     "version must be 1",
		"version = 1\naddress = \"GABC\"\n": "must be a contract id",
		"version = 1\n[[override]]\ndurability = \"forever\"\nkey = \"K\"\nvalue = \"true\"\n": "durability must be instance",
		"version = 1\n[[override]]\ndurability = \"instance\"\nkey = \"K\"\n":                  "needs a value, or unset = true",
		"version = 1\n[diff]\nresource_tolerance = { cpu = \"10%\" }\n":                        `resource_tolerance names "cpu"`,
		"version = 1\n[diff]\nresource_tolerance = { fee = \"ten\" }\n":                        "must be a percentage",
		"version = 1\n[diff]\nresource_tolerance = { fee = \"-5\" }\n":                         "must be a percentage",
		"version = 1\n[diff]\nignore_storage = [\"Balance(\"]\n":                               "unclosed bracket",
		"version = 1\n[diff]\nignore_storage = [\"5\"]\n":                                      "must be *, a name",
		"version = 1\n[diff]\nignore_storage = [\"Owner(\\\"al)\"]\n":                          "unclosed quote",
		"version = 1\n[diff]\nignore_events = [\"transfer//x\"]\n":                             "none empty",
		"version = 1\n[diff]\nignore_auth = \"yes\"\n":                                         "ignore_auth",
		"version = 1\n[replay]\nrecent_transactions = -1\n":                                    "0 or more",
	} {
		if _, err := Parse("t", []byte(text)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", text, err, want)
		}
	}
}

func TestDiffRulesThatRead(t *testing.T) {
	text := "version = 1\n[diff]\nignore_events = [\"transfer\", \"transfer/GABC\"]\n" +
		"ignore_storage = ['Balance(*)', 'Owner(\"a,b)\")', \"count\", \"u32:5\", '\"s\"', \"*\"]\n" +
		"ignore_auth = true\nresource_tolerance = { instructions = \"10%\", fee = \"500\", mem_bytes = \"2.5%\" }\n"
	f, err := Parse("t", []byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Diff.IgnoreStorage) != 6 || !f.Diff.IgnoreAuth || f.Diff.ResourceTolerance["fee"] != "500" {
		t.Fatalf("%+v", f.Diff)
	}
	out, err := f.Encode()
	if err != nil || !strings.Contains(string(out), "ignore_auth = true") || !strings.Contains(string(out), "ignore_storage") {
		t.Fatalf("encode: %v\n%s", err, out)
	}
}

func TestCallsAreCheckedAgainstTheDeployedContract(t *testing.T) {
	f, err := Parse("signet.dev.toml", docsExample(t))
	if err != nil {
		t.Fatal(err)
	}
	contract := Contract{
		Functions: map[string]bool{"count": true, "claim": true},
		Errors:    map[string]bool{"HandleTaken": true},
		EncodeArgs: func(fn string, args map[string]any) error {
			if fn == "claim" && args["wallet"] == nil {
				return errors.New("wallet: missing")
			}
			return nil
		},
	}
	if err := f.CheckCalls("signet.dev.toml", contract); err != nil {
		t.Fatal(err)
	}
	f.Calls[0].Function = "counts"
	delete(f.Calls[1].Args, "wallet")
	f.Calls = append(f.Calls, Call{Name: "x", Function: "count", Expect: Expect{Kind: "error", Error: "Nope"}})
	err = f.CheckCalls("signet.dev.toml", contract)
	for _, want := range []string{`the contract has no function "counts"`, "wallet: missing", `the contract has no error "Nope"`} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("lacks %q: %v", want, err)
		}
	}
}

func TestAppendCallKeepsTheFileAndReparses(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	original := "# the registry's checks\nversion = 1   # schema\n\n[[call]]\nname = \"count\"   # keep me\nfunction = \"count\"\nexpect = \"unchanged\""
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{
		"handle": "alice", "wallet": "GA5Z", "n": float64(5), "flags": []any{true, false},
		"opt": nil, "nested": map[string]any{"odd key": "x"},
	}
	if err := AppendCall(path, Call{Name: "claim alice", Function: "claim", Args: args, Expect: Expect{Kind: "unchanged"}}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(raw), original+"\n") {
		t.Fatalf("the original is not kept byte for byte:\n%s", raw)
	}
	f, err := Parse(path, raw)
	if err != nil {
		t.Fatalf("%v\n%s", err, raw)
	}
	saved := f.Calls[1]
	delete(args, "opt") // an Option left out
	got, _ := json.Marshal(saved.Args)
	want, _ := json.Marshal(args)
	if saved.Name != "claim alice" || saved.Function != "claim" || saved.Expect.Kind != "unchanged" || string(got) != string(want) {
		t.Fatalf("saved %+v (args %s, want %s)\n%s", saved, got, want, raw)
	}

	if err := AppendCall(path, Call{Name: "count", Function: "count", Expect: Expect{Kind: "unchanged"}}); err == nil || !strings.Contains(err.Error(), `"count" is already saved`) {
		t.Fatalf("duplicate: %v", err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(raw) {
		t.Fatal("a refused save changed the file")
	}
}

func TestFindWalksUp(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "a", "b")
	_ = os.MkdirAll(deep, 0o755)
	if Find(deep) != "" {
		t.Fatal("found a file that is not there")
	}
	_ = os.WriteFile(filepath.Join(root, FileName), []byte("version = 1\n"), 0o644)
	if got := Find(deep); got != filepath.Join(root, FileName) {
		t.Fatalf("Find = %q", got)
	}
}
