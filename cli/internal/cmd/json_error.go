package cmd

import (
	"encoding/json"
	"errors"
	"io"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
	"github.com/blockchain-maxis/signet/cli/internal/simulator"
)

// CliError is the top-level structured error written to stderr under --json.
type CliError struct {
	Error ErrorBody `json:"error"`
}

// ErrorBody holds the structured fields for a failed CLI command.
type ErrorBody struct {
	Kind     string         `json:"kind"`
	ExitCode int            `json:"exitCode"`
	Message  string         `json:"message"`
	Code     string         `json:"code,omitempty"`
	Detail   map[string]any `json:"detail,omitempty"`
}

// JSONError constructs the CliError payload for err.
func JSONError(err error) CliError {
	if err == nil {
		return CliError{
			Error: ErrorBody{
				Kind:     "ok",
				ExitCode: 0,
			},
		}
	}

	code, detail := extractErrorDetails(err)
	msg := redact.Secrets(err.Error())

	return CliError{
		Error: ErrorBody{
			Kind:     ExitKind(err),
			ExitCode: ExitCode(err),
			Message:  msg,
			Code:     code,
			Detail:   detail,
		},
	}
}

// extractErrorDetails retrieves machine-readable code and detail from known error types:
//   - simulator.Error carries Code, Detail and Stderr (as detail.stderr)
//   - simulator.StartError carries Stderr (as detail.stderr)
//   - api.Error carries Code (spec.CliFailureCode)
func extractErrorDetails(err error) (string, map[string]any) {
	var code string
	var detail map[string]any

	var simErr *simulator.Error
	if errors.As(err, &simErr) {
		if simErr.Code != "" {
			code = simErr.Code
		}
		if len(simErr.Detail) > 0 {
			detail = make(map[string]any, len(simErr.Detail)+1)
			for k, v := range simErr.Detail {
				detail[k] = v
			}
		}
		if len(simErr.Stderr) > 0 {
			if detail == nil {
				detail = make(map[string]any)
			}
			detail["stderr"] = simErr.Stderr
		}
		return code, detail
	}

	var simStartErr *simulator.StartError
	if errors.As(err, &simStartErr) {
		if len(simStartErr.Stderr) > 0 {
			detail = map[string]any{"stderr": simStartErr.Stderr}
		}
		return code, detail
	}

	var apiErr *api.Error
	if errors.As(err, &apiErr) {
		if apiErr.Code != "" {
			code = string(apiErr.Code)
		}
		return code, detail
	}

	return code, detail
}

// WriteErrorJSON writes exactly one line to w representing the structured JSON error.
func WriteErrorJSON(w io.Writer, err error) error {
	v := JSONError(err)
	raw, marshalErr := json.Marshal(v)
	if marshalErr != nil {
		return marshalErr
	}
	_, writeErr := w.Write(append(raw, '\n'))
	return writeErr
}
