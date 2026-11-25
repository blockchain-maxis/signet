package cmd

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
)

// guidePath is the sandbox user guide (#642), tutorialPath its tutorial
// (#643), cliGuidePath the CLI guide (#927).
var (
	guidePath    = filepath.Join("..", "..", "..", "docs", "SANDBOX.md")
	tutorialPath = filepath.Join("..", "..", "..", "docs", "SANDBOX_TUTORIAL.md")
	cliGuidePath = filepath.Join("..", "..", "..", "docs", "CLI.md")
)

// signetCommands are the `signet …` commands a markdown file cites: every
// line of a shell code fence that starts with signet, and every inline code
// span that does (output blocks are text fences, and left out).
func signetCommands(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	fence, shell := false, false
	inline := regexp.MustCompile("`(signet [^`]+)`")
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if lang, ok := strings.CutPrefix(trimmed, "```"); ok {
			fence = !fence
			shell = fence && (lang == "bash" || lang == "sh" || lang == "shell")
			continue
		}
		if fence {
			if shell && strings.HasPrefix(trimmed, "signet ") {
				out = append(out, trimmed)
			}
			continue
		}
		for _, m := range inline.FindAllStringSubmatch(line, -1) {
			out = append(out, m[1])
		}
	}
	return out
}

// TestTheSandboxGuideCitesRealCommandsAndFlags resolves every signet
// command the guide shows against the real command tree: the command must
// exist and each --flag it passes must be one of its flags.
func TestTheSandboxGuideCitesRealCommandsAndFlags(t *testing.T) {
	root := newRootCmd("0.0.0-test", "abc1234")
	commands := signetCommands(t, guidePath)
	if len(commands) < 20 {
		t.Fatalf("found only %d signet commands in %s", len(commands), guidePath)
	}
	tutorial := signetCommands(t, tutorialPath)
	if len(tutorial) < 8 {
		t.Fatalf("found only %d signet commands in %s", len(tutorial), tutorialPath)
	}
	commands = append(commands, tutorial...)
	cliCmds := signetCommands(t, cliGuidePath)
	var cliContextConfigCmds []string
	for _, c := range cliCmds {
		trimmed := strings.TrimSpace(c)
		if strings.HasPrefix(trimmed, "signet context") || strings.HasPrefix(trimmed, "signet config") {
			cliContextConfigCmds = append(cliContextConfigCmds, trimmed)
		}
	}
	if len(cliContextConfigCmds) < 8 {
		t.Fatalf("found only %d signet context/config commands in %s", len(cliContextConfigCmds), cliGuidePath)
	}
	commands = append(commands, cliContextConfigCmds...)
	for _, line := range commands {
		line, _, _ = strings.Cut(line, " #") // a trailing comment
		fields := strings.Fields(line)[1:]
		var words []string
		for _, f := range fields {
			if strings.HasPrefix(f, "-") || strings.ContainsAny(f, "<…'\"=/.") {
				break
			}
			words = append(words, f)
		}
		cmd, rest, err := root.Find(words)
		if err != nil || (len(rest) > 0 && !cmd.HasAvailableSubCommands() && cmd.Args == nil) {
			t.Errorf("%q: no such command (%v)", line, err)
			continue
		}
		if cmd.HasAvailableSubCommands() && len(rest) > 0 {
			t.Errorf("%q: %q is not a subcommand of %q", line, rest[0], cmd.CommandPath())
			continue
		}
		for _, f := range fields {
			if !strings.HasPrefix(f, "--") {
				continue
			}
			name, _, _ := strings.Cut(strings.TrimPrefix(f, "--"), "=")
			name = strings.TrimRight(name, ",.;:)`")
			if !hasFlag(cmd, name) {
				t.Errorf("%q: %s has no --%s", line, cmd.CommandPath(), name)
			}
		}
	}
}

func hasFlag(cmd *cobra.Command, name string) bool {
	return cmd.Flags().Lookup(name) != nil || cmd.InheritedFlags().Lookup(name) != nil || cmd.PersistentFlags().Lookup(name) != nil
}

// tomlKeys are every key signet.dev.toml's schema has, from devconfig's
// struct tags.
func tomlKeys(t reflect.Type, out map[string]bool) {
	for t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice || t.Kind() == reflect.Map {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return
	}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag, _, _ := strings.Cut(f.Tag.Get("toml"), ",")
		if tag != "" && tag != "-" {
			out[tag] = true
		}
		tomlKeys(f.Type, out)
	}
}

// TestTheSandboxGuideNamesEverySignetDevTomlKey: every key the code reads
// is documented (#642).
func TestTheSandboxGuideNamesEverySignetDevTomlKey(t *testing.T) {
	raw, err := os.ReadFile(guidePath)
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	tomlKeys(reflect.TypeOf(devconfig.File{}), keys)
	if len(keys) < 15 {
		t.Fatalf("found only %d keys", len(keys))
	}
	for k := range keys {
		if !regexp.MustCompile(`(?m)(^|[^a-z_])` + regexp.QuoteMeta(k) + `([^a-z_]|$)`).Match(raw) {
			t.Errorf("signet.dev.toml's %q is not in %s", k, guidePath)
		}
	}
}

// TestDeploymentContextJSONExampleParsesWithConfigLoad ensures the v2 JSON
// example in docs/CLI.md parses with config.Load (#927).
func TestDeploymentContextJSONExampleParsesWithConfigLoad(t *testing.T) {
	isolateConfigDir(t)
	raw, err := os.ReadFile(cliGuidePath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(raw), "\n")
	inContextSection := false
	inJSON := false
	var jsonLines []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## Deployment contexts") {
			inContextSection = true
			continue
		}
		if inContextSection && strings.HasPrefix(trimmed, "## ") {
			break
		}
		if inContextSection {
			if strings.HasPrefix(trimmed, "```json") {
				inJSON = true
				continue
			}
			if inJSON && strings.HasPrefix(trimmed, "```") {
				break
			}
			if inJSON {
				jsonLines = append(jsonLines, line)
			}
		}
	}
	if len(jsonLines) == 0 {
		t.Fatalf("no json block found under ## Deployment contexts in %s", cliGuidePath)
	}
	jsonStr := strings.Join(jsonLines, "\n")

	cfgPath, err := config.Path()
	if err != nil {
		t.Fatalf("config.Path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(cfgPath, []byte(jsonStr), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	f, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load failed to parse JSON example from %s: %v", cliGuidePath, err)
	}
	if f.Version != 2 {
		t.Errorf("f.Version = %d, want 2", f.Version)
	}
	if f.Current == "" {
		t.Errorf("f.Current is empty, want a current context")
	}
	if len(f.Contexts) == 0 {
		t.Errorf("f.Contexts is empty")
	}
	if _, ok := f.Contexts[f.Current]; !ok {
		t.Errorf("current context %q not in f.Contexts", f.Current)
	}

	resolved, err := config.Resolve(config.ResolveOptions{}, f)
	if err != nil {
		t.Fatalf("config.Resolve: %v", err)
	}
	if resolved.BaseURL == "" || resolved.Network == "" {
		t.Errorf("resolved = %+v, want non-empty BaseURL and Network", resolved)
	}
}
