package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/link"
)

func TestExitCodeIsOKForNoError(t *testing.T) {
	if got := ExitCode(nil); got != exitcode.OK {
		t.Fatalf("ExitCode(nil) = %d, want %d", got, exitcode.OK)
	}
}

func TestExitCodeMapsAValidationErrorToInvalidInput(t *testing.T) {
	_, err := link.Link("Not Valid", "", "testnet")
	if err == nil {
		t.Fatal("expected link.Link to reject an invalid handle")
	}
	if got := ExitCode(err); got != exitcode.InvalidInput {
		t.Fatalf("ExitCode(validation error) = %d, want %d", got, exitcode.InvalidInput)
	}
}

func TestExitCodeMapsAnUnrecognizedErrorToGeneric(t *testing.T) {
	if got := ExitCode(errors.New("something unrelated broke")); got != exitcode.Generic {
		t.Fatalf("ExitCode(plain error) = %d, want %d", got, exitcode.Generic)
	}
}

func TestExitCodeUnwrapsAWrappedValidationError(t *testing.T) {
	_, linkErr := link.Link("Not Valid", "", "testnet")
	wrapped := fmt.Errorf("running link: %w", linkErr)
	if got := ExitCode(wrapped); got != exitcode.InvalidInput {
		t.Fatalf("ExitCode(wrapped validation error) = %d, want %d", got, exitcode.InvalidInput)
	}
}

func TestExitCodeConsultsTheSentinelTaxonomy(t *testing.T) {
	wrapped := fmt.Errorf("talking to the deployment: %w", exitcode.ErrNetwork)
	if got := ExitCode(wrapped); got != exitcode.Network {
		t.Fatalf("ExitCode(wrapped ErrNetwork) = %d, want %d", got, exitcode.Network)
	}
}

func TestExitCodeRootConfigErrorsCarryTheConfigurationCode(t *testing.T) {
	// A real caller, not a synthetic error: root's PersistentPreRunE wraps
	// exitcode.ErrConfiguration when the config file can't be read, since a
	// broken/unreadable config file is exactly what that code is for.
	isolateConfigDir(t)
	badPath, err := config.Path()
	if err != nil {
		t.Fatalf("config.Path: %v", err)
	}
	if err := os.MkdirAll(badPath, 0o755); err != nil {
		t.Fatalf("seeding an unreadable config path: %v", err)
	}

	root := newRootCmd("dev", "none")
	root.SetOut(&bytes.Buffer{})
	root.SetArgs([]string{})

	runErr := root.Execute()
	if runErr == nil {
		t.Fatal("expected an error when the config path is a directory, not a file")
	}
	if got := ExitCode(runErr); got != exitcode.Configuration {
		t.Fatalf("ExitCode(config load failure) = %d, want %d", got, exitcode.Configuration)
	}
}
