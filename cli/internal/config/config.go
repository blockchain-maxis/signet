// Package config resolves the signet CLI's runtime configuration — which
// Signet deployment to talk to, and which identity to sign as — from flags,
// an environment variable, a per-user config file, and built-in defaults, in
// that precedence order: flag > env > config file > default.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// DefaultBaseURL is the Signet deployment the CLI talks to when nothing else
// says otherwise: the hosted instance deployed from main. Self-hosters point
// elsewhere via SIGNET_URL, --url, or the config file.
const DefaultBaseURL = "https://signet-web-pearl.vercel.app"

// EnvBaseURL is the environment variable that overrides the config file's
// BaseURL, one level below an explicit --url flag.
const EnvBaseURL = "SIGNET_URL"

// fileName is the config file's name inside Dir().
const fileName = "config.json"

// File holds the fields persisted to disk. Both are optional: a fresh
// install has neither, which is exactly what makes the default deployment
// need no config file at all.
type File struct {
	// BaseURL is the last-configured Signet deployment.
	BaseURL string `json:"baseUrl,omitempty"`
	// Source is the last-used identity name — the argument commands that
	// sign take via --source (e.g. `signet link --source alice`).
	Source string `json:"source,omitempty"`
}

// Dir returns the directory the CLI's config file lives in:
// os.UserConfigDir()/signet.
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "signet"), nil
}

// Path returns the full path to the config file.
func Path() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, fileName), nil
}

// Load reads the config file. A missing file is not an error: it reads back
// as a zero-value File, so the default deployment works with no config file
// present at all.
func Load() (File, error) {
	path, err := Path()
	if err != nil {
		return File{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return File{}, nil
		}
		return File{}, err
	}
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		return File{}, err
	}
	return f, nil
}

// Save writes the config file, creating its directory if needed. Permissions
// are kept user-only (0700/0600): the file can carry a self-hosted deployment
// URL and an identity name that a wallet is associated with.
func Save(f File) error {
	dir, err := Dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path, err := Path()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// RememberSource updates just the Source field of the config file, leaving
// BaseURL as it was. Called after a command runs with an explicit --source,
// so the next invocation doesn't have to repeat it.
func RememberSource(source string) error {
	f, err := Load()
	if err != nil {
		return err
	}
	if f.Source == source {
		return nil
	}
	f.Source = source
	return Save(f)
}

// Resolved is the configuration actually in effect for one invocation, after
// applying precedence.
type Resolved struct {
	BaseURL string
	Source  string
}

// ResolveOptions carries the flag/environment inputs for one invocation.
// FlagURL and FlagSource are only honored when their *Set companion is true
// — cobra's Flags().Changed(name) — so an explicitly empty flag value (e.g.
// an empty --source) is still distinguishable from "the flag wasn't passed".
type ResolveOptions struct {
	FlagURL       string
	FlagURLSet    bool
	FlagSource    string
	FlagSourceSet bool
	// EnvBaseURL is the SIGNET_URL environment variable's value, or "" if
	// unset. Passed in rather than read via os.Getenv inside Resolve so tests
	// don't need to mutate process-global environment state.
	EnvBaseURL string
}

// Resolve combines flags, environment, the config file, and the built-in
// default into the configuration actually in effect: flag > env > config >
// default, decided independently per field.
func Resolve(opts ResolveOptions, file File) Resolved {
	r := Resolved{
		BaseURL: DefaultBaseURL,
		Source:  file.Source,
	}

	if file.BaseURL != "" {
		r.BaseURL = file.BaseURL
	}
	if opts.EnvBaseURL != "" {
		r.BaseURL = opts.EnvBaseURL
	}
	if opts.FlagURLSet {
		r.BaseURL = opts.FlagURL
	}

	if opts.FlagSourceSet {
		r.Source = opts.FlagSource
	}

	return r
}
