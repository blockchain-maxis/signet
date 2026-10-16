// Package config resolves the signet CLI's runtime configuration — which
// Signet deployment to talk to, which Stellar network to target, and which
// identity to sign as — from flags, environment variables, a per-user config
// file, and built-in defaults, in that precedence order:
// flag > env > current context > default.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// DefaultBaseURL is the Signet deployment the CLI talks to when nothing else
// says otherwise: the hosted instance deployed from main. Self-hosters point
// elsewhere via SIGNET_URL, --url, or the config file.
const DefaultBaseURL = "https://signet-web-pearl.vercel.app"

// DefaultNetwork is the Stellar network the CLI targets when none is specified.
const DefaultNetwork = "testnet"

// DefaultContextName is the default context name in schema v2.
const DefaultContextName = "default"

// EnvBaseURL is the environment variable that overrides the config file's
// BaseURL, one level below an explicit --url flag.
const EnvBaseURL = "SIGNET_URL"

// EnvNetwork is the environment variable that overrides the context network,
// one level below an explicit --network flag.
const EnvNetwork = "SIGNET_NETWORK"

// EnvContext is the environment variable that overrides the active context name,
// one level below an explicit --context flag.
const EnvContext = "SIGNET_CONTEXT"

// EnvSignWithKey is the identity `stellar tx sign --sign-with-key` already
// reads from the environment. signet honours the same variable rather than
// inventing a second one, so a CI job exports its deploy identity once and
// both tools see it (#254).
const EnvSignWithKey = "STELLAR_SIGN_WITH_KEY"

// fileName is the config file's name inside Dir().
const fileName = "config.json"

// Context holds the configuration properties for a single named deployment context.
type Context struct {
	// URL is the Signet deployment endpoint.
	URL string `json:"url,omitempty"`
	// Network is the Stellar network (e.g. testnet, mainnet).
	Network string `json:"network,omitempty"`
	// Source is the default identity name for this context.
	Source string `json:"source,omitempty"`
}

// File holds the configuration persisted to disk (Schema v2).
type File struct {
	Version  int                `json:"version"`
	Current  string             `json:"current"`
	Contexts map[string]Context `json:"contexts"`

	// Legacy v1 fields kept for transparent migration and memory backward compatibility.
	BaseURL string `json:"baseUrl,omitempty"`
	Source  string `json:"source,omitempty"`
}

// ContextError is an error raised by context and config operations that carries
// an explicit exit code (e.g. exitcode.InvalidInput = 2).
type ContextError struct {
	Msg  string
	Code int
}

func (e *ContextError) Error() string {
	return e.Msg
}

// ExitCode implements cmd.ExitCoder.
func (e *ContextError) ExitCode() int {
	return e.Code
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
// as an empty File, so the default deployment works with no config file
// present at all.
//
// When a v1 file ({baseUrl, source}) is detected, Load transparently migrates it
// to schema v2, writes a `.bak` backup copy of the original file, saves the
// migrated v2 file, and returns the v2 File.
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

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return File{}, err
	}

	// Schema v2 check:
	if v, ok := raw["version"].(float64); ok && int(v) == 2 {
		var f File
		if err := json.Unmarshal(data, &f); err != nil {
			return File{}, err
		}
		if f.Contexts == nil {
			f.Contexts = make(map[string]Context)
		}
		if f.Current == "" {
			f.Current = DefaultContextName
		}
		curr := f.CurrentContext()
		f.BaseURL = curr.URL
		f.Source = curr.Source
		return f, nil
	}

	// Transparently migrate v1 to v2:
	// 1. Write <path>.bak backup of the original unmigrated file.
	bakPath := path + ".bak"
	if err := os.WriteFile(bakPath, data, 0o600); err != nil {
		return File{}, err
	}

	// 2. Extract v1 fields.
	baseURL, _ := raw["baseUrl"].(string)
	source, _ := raw["source"].(string)

	f := File{
		Version: 2,
		Current: DefaultContextName,
		Contexts: map[string]Context{
			DefaultContextName: {
				URL:    baseURL,
				Source: source,
			},
		},
		BaseURL: baseURL,
		Source:  source,
	}

	// 3. Persist migrated file.
	if err := Save(f); err != nil {
		return File{}, err
	}

	return f, nil
}

// Save writes the config file, creating its directory if needed. Permissions
// are kept user-only (0700/0600).
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

	if f.Version < 2 {
		f.Version = 2
	}
	if f.Current == "" {
		f.Current = DefaultContextName
	}
	if f.Contexts == nil {
		f.Contexts = make(map[string]Context)
	}

	// Migrate any in-memory legacy fields to the current context when Contexts is empty.
	if len(f.Contexts) == 0 && (f.BaseURL != "" || f.Source != "") {
		f.Contexts[f.Current] = Context{
			URL:    f.BaseURL,
			Source: f.Source,
		}
	}
	f.BaseURL = ""
	f.Source = ""

	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

// CurrentContext returns the currently active context, or an empty Context if not found.
func (f File) CurrentContext() Context {
	if f.Contexts == nil {
		return Context{}
	}
	name := f.Current
	if name == "" {
		name = DefaultContextName
	}
	return f.Contexts[name]
}

// UseContext changes the active context to name.
func (f *File) UseContext(name string) error {
	if f.Contexts == nil {
		return &ContextError{
			Msg:  fmt.Sprintf("context %q not found", name),
			Code: exitcode.InvalidInput,
		}
	}
	if _, ok := f.Contexts[name]; !ok {
		return &ContextError{
			Msg:  fmt.Sprintf("context %q not found", name),
			Code: exitcode.InvalidInput,
		}
	}
	f.Current = name
	return nil
}

// AddContext adds or updates a named context.
func (f *File) AddContext(name string, ctx Context) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return &ContextError{
			Msg:  "context name cannot be empty",
			Code: exitcode.InvalidInput,
		}
	}
	if strings.TrimSpace(ctx.URL) == "" {
		return &ContextError{
			Msg:  "--url is required",
			Code: exitcode.InvalidInput,
		}
	}
	if strings.TrimSpace(ctx.Network) == "" {
		return &ContextError{
			Msg:  "--network is required",
			Code: exitcode.InvalidInput,
		}
	}
	if f.Contexts == nil {
		f.Contexts = make(map[string]Context)
	}
	f.Contexts[name] = ctx
	if f.Current == "" {
		f.Current = name
	}
	return nil
}

// RemoveContext deletes a named context. Attempting to delete the currently active
// context is refused with exit code 2 (exitcode.InvalidInput).
func (f *File) RemoveContext(name string) error {
	current := f.Current
	if current == "" {
		current = DefaultContextName
	}
	if name == current {
		return &ContextError{
			Msg:  fmt.Sprintf("cannot remove the current context %q; switch to another context first", name),
			Code: exitcode.InvalidInput,
		}
	}
	if f.Contexts == nil {
		return &ContextError{
			Msg:  fmt.Sprintf("context %q not found", name),
			Code: exitcode.InvalidInput,
		}
	}
	if _, ok := f.Contexts[name]; !ok {
		return &ContextError{
			Msg:  fmt.Sprintf("context %q not found", name),
			Code: exitcode.InvalidInput,
		}
	}
	delete(f.Contexts, name)
	return nil
}

// GetConfig reads a configuration key (url, network, source) from the current context.
func (f File) GetConfig(key string) (string, error) {
	ctx := f.CurrentContext()
	switch strings.ToLower(key) {
	case "url":
		return ctx.URL, nil
	case "network":
		return ctx.Network, nil
	case "source":
		return ctx.Source, nil
	default:
		return "", &ContextError{
			Msg:  fmt.Sprintf("invalid config key %q: valid keys are url, network, source", key),
			Code: exitcode.InvalidInput,
		}
	}
}

// SetConfig sets a configuration key (url, network, source) in the current context.
func (f *File) SetConfig(key, value string) error {
	curr := f.Current
	if curr == "" {
		curr = DefaultContextName
		f.Current = curr
	}
	if f.Contexts == nil {
		f.Contexts = make(map[string]Context)
	}
	ctx := f.Contexts[curr]
	switch strings.ToLower(key) {
	case "url":
		ctx.URL = value
	case "network":
		ctx.Network = value
	case "source":
		ctx.Source = value
	default:
		return &ContextError{
			Msg:  fmt.Sprintf("invalid config key %q: valid keys are url, network, source", key),
			Code: exitcode.InvalidInput,
		}
	}
	f.Contexts[curr] = ctx
	return nil
}

// UnsetConfig unsets a configuration key (url, network, source) in the current context.
func (f *File) UnsetConfig(key string) error {
	curr := f.Current
	if curr == "" {
		curr = DefaultContextName
		f.Current = curr
	}
	if f.Contexts == nil {
		f.Contexts = make(map[string]Context)
	}
	ctx := f.Contexts[curr]
	switch strings.ToLower(key) {
	case "url":
		ctx.URL = ""
	case "network":
		ctx.Network = ""
	case "source":
		ctx.Source = ""
	default:
		return &ContextError{
			Msg:  fmt.Sprintf("invalid config key %q: valid keys are url, network, source", key),
			Code: exitcode.InvalidInput,
		}
	}
	f.Contexts[curr] = ctx
	return nil
}

// RememberSource updates the Source field of the current context in the config file.
func RememberSource(source string) error {
	return RememberSourceInContext("", source)
}

// RememberSourceInContext updates the Source field of the target context (or current
// context if empty) in the config file.
func RememberSourceInContext(contextName, source string) error {
	f, err := Load()
	if err != nil {
		return err
	}
	if f.Contexts == nil {
		f.Contexts = make(map[string]Context)
	}
	target := contextName
	if target == "" {
		target = f.Current
	}
	if target == "" {
		target = DefaultContextName
		f.Current = target
	}
	currCtx := f.Contexts[target]
	if currCtx.Source == source {
		return nil
	}
	currCtx.Source = source
	f.Contexts[target] = currCtx
	return Save(f)
}

// Resolved is the configuration actually in effect for one invocation, after
// applying precedence.
type Resolved struct {
	BaseURL string
	Network string
	Source  string
	Context string
}

// ResolveOptions carries the flag/environment inputs for one invocation.
type ResolveOptions struct {
	FlagURL            string
	FlagURLSet         bool
	FlagNetwork        string
	FlagNetworkSet     bool
	FlagSource         string
	FlagSourceSet      bool
	FlagSignWithKey    string
	FlagSignWithKeySet bool
	FlagContext        string
	FlagContextSet     bool

	EnvBaseURL     string
	EnvNetwork     string
	EnvContext     string
	EnvSignWithKey string
}

// Resolve combines flags, environment, the config file, and built-in defaults
// into the configuration actually in effect for this invocation:
// flag > env > current context > default, decided per field.
func Resolve(opts ResolveOptions, file File) Resolved {
	contextName := DefaultContextName
	if file.Current != "" {
		contextName = file.Current
	}
	if opts.EnvContext != "" {
		contextName = opts.EnvContext
	}
	if opts.FlagContextSet && opts.FlagContext != "" {
		contextName = opts.FlagContext
	}

	var activeCtx Context
	if file.Contexts != nil {
		activeCtx = file.Contexts[contextName]
	} else if contextName == DefaultContextName && (file.BaseURL != "" || file.Source != "") {
		activeCtx = Context{
			URL:    file.BaseURL,
			Source: file.Source,
		}
	}

	r := Resolved{
		BaseURL: DefaultBaseURL,
		Network: DefaultNetwork,
		Source:  activeCtx.Source,
		Context: contextName,
	}

	// BaseURL: flag > env > context > default
	if activeCtx.URL != "" {
		r.BaseURL = activeCtx.URL
	}
	if opts.EnvBaseURL != "" {
		r.BaseURL = opts.EnvBaseURL
	}
	if opts.FlagURLSet {
		r.BaseURL = opts.FlagURL
	}

	// Network: flag > env > context > default
	if activeCtx.Network != "" {
		r.Network = activeCtx.Network
	}
	if opts.EnvNetwork != "" {
		r.Network = opts.EnvNetwork
	}
	if opts.FlagNetworkSet {
		r.Network = opts.FlagNetwork
	}

	// Identity: --sign-with-key > --source > STELLAR_SIGN_WITH_KEY > context
	if opts.EnvSignWithKey != "" {
		r.Source = opts.EnvSignWithKey
	}
	if opts.FlagSourceSet {
		r.Source = opts.FlagSource
	}
	if opts.FlagSignWithKeySet {
		r.Source = opts.FlagSignWithKey
	}

	return r
}
