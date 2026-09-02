package cmd

import (
	"errors"
	"fmt"
	"testing"

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
