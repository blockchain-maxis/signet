package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/jsonschema"
	"github.com/blockchain-maxis/signet/cli/internal/pair"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
	"github.com/blockchain-maxis/signet/cli/internal/spec"
)

type dummyExitCoder struct {
	code int
	msg  string
}

func (e dummyExitCoder) Error() string { return e.msg }
func (e dummyExitCoder) ExitCode() int { return e.code }

func TestJSONErrorPerExitCode(t *testing.T) {
	schemaPath := filepath.Join("..", "..", "..", "sandbox", "protocol", "schema", "v1", "cli-error.json")
	schema, err := jsonschema.Load(schemaPath)
	if err != nil {
		t.Fatalf("loading schema %s: %v", schemaPath, err)
	}

	cases := []struct {
		name     string
		err      error
		wantCode int
		wantKind string
	}{
		{"configuration", exitcode.ErrConfiguration, exitcode.Configuration, "configuration"},
		{"no_identity", exitcode.ErrNoIdentity, exitcode.NoIdentity, "no_identity"},
		{"signing_failed", exitcode.ErrSigningFailure, exitcode.SigningFailure, "signing_failed"},
		{"network", exitcode.ErrNetwork, exitcode.Network, "network"},
		{"timeout", exitcode.ErrTimeout, exitcode.Timeout, "timeout"},
		{"approval_rejected", exitcode.ErrApprovalRejected, exitcode.ApprovalRejected, "approval_rejected"},
		{"already_linked", exitcode.ErrAlreadyLinked, exitcode.AlreadyLinked, "already_linked"},
		{"diff_found", exitcode.ErrDiffFound, exitcode.DiffFound, "diff_found"},
		{"host_unsupported", exitcode.ErrHostUnsupported, exitcode.HostUnsupported, "host_unsupported"},
		{"build_failed", exitcode.ErrBuildFailed, exitcode.BuildFailed, "build_failed"},
		{"simulator_failure", exitcode.ErrSimulator, exitcode.SimulatorFailure, "simulator_failure"},
		{"no_spec", exitcode.ErrNoSpec, exitcode.NoSpec, "no_spec"},
		{"interrupted", exitcode.ErrInterrupted, exitcode.Interrupted, "interrupted"},
		{"invalid_input", dummyExitCoder{code: exitcode.InvalidInput, msg: "invalid handle"}, exitcode.InvalidInput, "invalid_input"},
		{"generic", errors.New("unexpected error occurred"), exitcode.Generic, "generic"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := newRootCmd("dev", "none")
			root.AddCommand(&cobra.Command{
				Use: "failing-subcommand",
				RunE: func(*cobra.Command, []string) error {
					return tc.err
				},
			})

			stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
			root.SetOut(stdout)
			root.SetErr(stderr)
			root.SetArgs([]string{"failing-subcommand", "--json"})

			runErr := Run(root)
			if runErr == nil {
				t.Fatal("expected an error, got nil")
			}

			if stdout.Len() != 0 {
				t.Fatalf("stdout was not empty: %q", stdout.String())
			}

			lines := strings.Split(strings.TrimRight(stderr.String(), "\n"), "\n")
			if len(lines) != 1 {
				t.Fatalf("expected exactly one line on stderr, got %d lines: %q", len(lines), stderr.String())
			}

			var parsed map[string]any
			if err := json.Unmarshal([]byte(lines[0]), &parsed); err != nil {
				t.Fatalf("stderr did not parse as JSON: %v (raw: %q)", err, lines[0])
			}

			if errs := jsonschema.Validate(schema, schema, parsed); len(errs) > 0 {
				t.Fatalf("JSON schema validation failed: %v", errs)
			}

			errObj, ok := parsed["error"].(map[string]any)
			if !ok {
				t.Fatalf("expected error object, got %T", parsed["error"])
			}
			if gotKind := errObj["kind"]; gotKind != tc.wantKind {
				t.Errorf("kind = %v, want %v", gotKind, tc.wantKind)
			}
			if gotCode := int(errObj["exitCode"].(float64)); gotCode != tc.wantCode {
				t.Errorf("exitCode = %d, want %d", gotCode, tc.wantCode)
			}
		})
	}
}

func TestJSONErrorDetailsAndCodes(t *testing.T) {
	schemaPath := filepath.Join("..", "..", "..", "sandbox", "protocol", "schema", "v1", "cli-error.json")
	schema, err := jsonschema.Load(schemaPath)
	if err != nil {
		t.Fatalf("loading schema %s: %v", schemaPath, err)
	}

	t.Run("server_refusal_code", func(t *testing.T) {
		apiErr := &api.Error{
			Status:  400,
			Code:    spec.CliFailureCodeBadRequest,
			Message: "invalid request payload",
		}

		root := newRootCmd("dev", "none")
		root.AddCommand(&cobra.Command{
			Use: "fail-api",
			RunE: func(*cobra.Command, []string) error {
				return apiErr
			},
		})

		stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
		root.SetOut(stdout)
		root.SetErr(stderr)
		root.SetArgs([]string{"fail-api", "--json"})

		if err := Run(root); err == nil {
			t.Fatal("expected error")
		}
		if stdout.Len() != 0 {
			t.Fatalf("stdout not empty: %q", stdout.String())
		}

		var parsed map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(stderr.Bytes()), &parsed); err != nil {
			t.Fatalf("unmarshal stderr: %v", err)
		}
		if errs := jsonschema.Validate(schema, schema, parsed); len(errs) > 0 {
			t.Fatalf("schema validation failed: %v", errs)
		}

		errObj := parsed["error"].(map[string]any)
		if errObj["code"] != string(spec.CliFailureCodeBadRequest) {
			t.Errorf("code = %v, want %v", errObj["code"], spec.CliFailureCodeBadRequest)
		}
	})

	t.Run("simulator_error_detail_and_stderr", func(t *testing.T) {
		secret := "S" + strings.Repeat("A", 55)
		simErr := &simulator.Error{
			Code:    "internal_panic",
			Message: "simulator trapped",
			Detail:  map[string]any{"trap": "unreachable", "seed": "signing with " + secret},
			Stderr:  []string{"panicked at wasm.rs:42", "secret key: " + secret},
		}

		root := newRootCmd("dev", "none")
		root.AddCommand(&cobra.Command{
			Use: "fail-sim",
			RunE: func(*cobra.Command, []string) error {
				return simErr
			},
		})

		stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
		root.SetOut(stdout)
		root.SetErr(stderr)
		root.SetArgs([]string{"fail-sim", "--json"})

		if err := Run(root); err == nil {
			t.Fatal("expected error")
		}
		if stdout.Len() != 0 {
			t.Fatalf("stdout not empty: %q", stdout.String())
		}

		var parsed map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(stderr.Bytes()), &parsed); err != nil {
			t.Fatalf("unmarshal stderr: %v", err)
		}
		if errs := jsonschema.Validate(schema, schema, parsed); len(errs) > 0 {
			t.Fatalf("schema validation failed: %v", errs)
		}

		errObj := parsed["error"].(map[string]any)
		if errObj["kind"] != "simulator_failure" {
			t.Errorf("kind = %v, want simulator_failure", errObj["kind"])
		}
		if errObj["code"] != "internal_panic" {
			t.Errorf("code = %v, want internal_panic", errObj["code"])
		}
		detail, ok := errObj["detail"].(map[string]any)
		if !ok {
			t.Fatalf("missing detail object: %v", errObj)
		}
		if detail["trap"] != "unreachable" {
			t.Errorf("detail.trap = %v, want unreachable", detail["trap"])
		}
		stderrList, ok := detail["stderr"].([]any)
		if !ok || len(stderrList) != 2 {
			t.Fatalf("detail.stderr = %v, want 2 lines", detail["stderr"])
		}
		if stderrList[0] != "panicked at wasm.rs:42" {
			t.Errorf("detail.stderr[0] = %v, want the first stderr line", stderrList[0])
		}
		if stderrList[1] != "secret key: "+redact.Placeholder {
			t.Errorf("detail.stderr[1] = %v, want the secret redacted", stderrList[1])
		}
		if detail["seed"] != "signing with "+redact.Placeholder {
			t.Errorf("detail.seed = %v, want the secret redacted", detail["seed"])
		}
		if raw := stderr.String(); strings.Contains(raw, secret) {
			t.Errorf("stderr leaks the secret: %s", raw)
		}

		msg, _ := errObj["message"].(string)
		if msg != "simulator error (internal_panic): simulator trapped" {
			t.Errorf("message = %q, want it without the stderr tail", msg)
		}
		if strings.Contains(msg, "panicked at") || strings.Contains(msg, "last lines") {
			t.Errorf("message carries the stderr tail: %q", msg)
		}
	})
}

func TestGolden_LinkRejectedJSONStderr(t *testing.T) {
	isolateConfigDir(t)
	buildFakeStellarOnPath(t)
	withFakeSigning(t)
	srv := goldenServer(t, "rejected", pair.Identity{})

	root := newRootCmdWithDeps(goldenVersion, "abc1234", defaultDeps())
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetIn(strings.NewReader(""))
	root.SetArgs([]string{"link", "--url", srv.URL, "--source", "alice", "--no-browser", "--json"})

	err := Run(root)
	if err == nil {
		t.Fatal("expected link to fail when rejected")
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout was not empty: %q", stdout.String())
	}

	assertGolden(t, "link_rejected_json_stderr", stderr.String())
}
