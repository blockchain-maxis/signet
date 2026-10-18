package cmd

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

// lastErrorFile is the name of the file the most recent failure is written to,
// inside the CLI's cache directory. `signet bug-report` reads it so a report
// does not have to reproduce the failure to include it.
const lastErrorFile = "last-error.json"

// LastError is the persisted record of the most recent failure. Every field is
// redacted before it is written and again when it is read, so a file edited by
// hand cannot smuggle a secret into a bug report.
type LastError struct {
	At      time.Time `json:"at"`
	Message string    `json:"message"`
	Chain   []string  `json:"chain,omitempty"`
}

// cacheDir returns the directory signet writes diagnostics to:
// os.UserCacheDir()/signet. On Unix that honours $XDG_CACHE_HOME.
func cacheDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "signet"), nil
}

// lastErrorPath returns the full path to the last-error file.
func lastErrorPath() (string, error) {
	dir, err := cacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, lastErrorFile), nil
}

// recordLastError persists err for the next `signet bug-report`. It is
// best-effort: a diagnostics cache that cannot be written must never turn a
// reported failure into a crash, so every error here is dropped.
func recordLastError(err error) {
	if err == nil {
		return
	}
	path, pathErr := lastErrorPath()
	if pathErr != nil {
		return
	}
	if mkErr := os.MkdirAll(filepath.Dir(path), 0o700); mkErr != nil {
		return
	}
	rec := LastError{
		At:      time.Now().UTC(),
		Message: redact.Secrets(err.Error()),
		Chain:   errorChain(err),
	}
	data, marshalErr := json.MarshalIndent(rec, "", "  ")
	if marshalErr != nil {
		return
	}
	_ = os.WriteFile(path, append(data, '\n'), 0o600)
}

// errorChain lists each wrapped error's message, outermost first, after
// redaction. The outermost message already contains the inner ones; the list
// keeps them separable for a report.
func errorChain(err error) []string {
	var chain []string
	for err != nil {
		chain = append(chain, redact.Secrets(err.Error()))
		err = errors.Unwrap(err)
	}
	return chain
}

// readLastError returns the recorded failure, or (nil, nil) when none has been
// saved. Values are redacted on read so a hand-edited file is still safe to
// print.
func readLastError() (*LastError, error) {
	path, err := lastErrorPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var rec LastError
	if err := json.Unmarshal(data, &rec); err != nil {
		return nil, err
	}
	rec.Message = redact.Secrets(rec.Message)
	for i := range rec.Chain {
		rec.Chain[i] = redact.Secrets(rec.Chain[i])
	}
	return &rec, nil
}
