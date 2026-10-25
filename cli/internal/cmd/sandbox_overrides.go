package cmd

import (
	"errors"
	"fmt"
	"strings"

	"github.com/BurntSushi/toml"

	"github.com/blockchain-maxis/signet/cli/internal/devconfig"
)

// storageOverride is one --set-storage, --unset-storage or [[override]]
// (#559): a contract's storage entry, set or removed, in the override layer.
type storageOverride struct {
	durability string
	key        string
	value      string
	unset      bool
	// source is how the user wrote it, for messages.
	source string
}

const overrideShape = "<instance|persistent|temporary>:<key>=<value>"

// parseStorageOverrides reads the override flags and file, the file first.
func parseStorageOverrides(sets, unsets []string, file string) ([]storageOverride, error) {
	var out []storageOverride
	if file != "" {
		fromFile, err := readOverridesFile(file)
		if err != nil {
			return nil, err
		}
		out = append(out, fromFile...)
	}
	for _, s := range sets {
		durability, rest, err := splitDurability("--set-storage", s, overrideShape)
		if err != nil {
			return nil, err
		}
		key, value, ok := splitAssignment(rest)
		if !ok || strings.TrimSpace(key) == "" || strings.TrimSpace(value) == "" {
			return nil, &inputError{fmt.Sprintf("--set-storage %q: want %s, e.g. 'persistent:Owner(\"alice\")=\"G…\"'", s, overrideShape)}
		}
		out = append(out, storageOverride{durability: durability, key: key, value: value, source: "--set-storage " + s})
	}
	for _, s := range unsets {
		durability, key, err := splitDurability("--unset-storage", s, "<instance|persistent|temporary>:<key>")
		if err != nil {
			return nil, err
		}
		out = append(out, storageOverride{durability: durability, key: key, unset: true, source: "--unset-storage " + s})
	}
	return out, nil
}

func splitDurability(flag, s, shape string) (string, string, error) {
	durability, rest, ok := strings.Cut(s, ":")
	switch durability {
	case "instance", "persistent", "temporary":
	default:
		ok = false
	}
	if !ok || strings.TrimSpace(rest) == "" {
		return "", "", &inputError{fmt.Sprintf("%s %q: want %s", flag, s, shape)}
	}
	return durability, strings.TrimSpace(rest), nil
}

// splitAssignment splits `key=value` at the first `=` outside quotes and
// brackets, so a key like Owner("a=b") stays whole.
func splitAssignment(s string) (string, string, bool) {
	depth, quoted, escaped := 0, false, false
	for i, r := range s {
		if quoted {
			switch {
			case escaped:
				escaped = false
			case r == '\\':
				escaped = true
			case r == '"':
				quoted = false
			}
			continue
		}
		switch r {
		case '"':
			quoted = true
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		case '=':
			if depth == 0 {
				return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i+1:]), true
			}
		}
	}
	return "", "", false
}

// overridesFile is the [[override]] tables of signet.dev.toml (#560):
// durability, key and value, or unset = true.
type overridesFile struct {
	Override []struct {
		Durability string `toml:"durability"`
		Key        string `toml:"key"`
		Value      string `toml:"value"`
		Unset      bool   `toml:"unset"`
	} `toml:"override"`
}

func readOverridesFile(path string) ([]storageOverride, error) {
	// A whole signet.dev.toml (it has a version) gives its [[override]]s.
	var peek map[string]any
	if _, err := toml.DecodeFile(path, &peek); err == nil && peek["version"] != nil {
		dev, err := devconfig.Load(path)
		if err != nil {
			return nil, &inputError{fmt.Sprintf("--overrides %v", err)}
		}
		out := make([]storageOverride, 0, len(dev.Overrides))
		for i, o := range dev.Overrides {
			out = append(out, storageOverride{
				durability: o.Durability, key: o.Key, value: o.Value, unset: o.Unset,
				source: fmt.Sprintf("--overrides %s: override %d (%s:%s)", path, i+1, o.Durability, o.Key),
			})
		}
		return out, nil
	}
	var f overridesFile
	meta, err := toml.DecodeFile(path, &f)
	if err != nil {
		var perr toml.ParseError
		if errors.As(err, &perr) {
			return nil, &inputError{fmt.Sprintf("--overrides %s: %s", path, perr.Error())}
		}
		return nil, &inputError{fmt.Sprintf("--overrides %s: %v", path, err)}
	}
	if undecoded := meta.Undecoded(); len(undecoded) > 0 {
		keys := make([]string, len(undecoded))
		for i, k := range undecoded {
			keys[i] = k.String()
		}
		return nil, &inputError{fmt.Sprintf("--overrides %s: unknown keys %s; an [[override]] has durability, key, and value or unset = true", path, strings.Join(keys, ", "))}
	}
	out := make([]storageOverride, 0, len(f.Override))
	for i, o := range f.Override {
		where := fmt.Sprintf("--overrides %s: override %d", path, i+1)
		switch o.Durability {
		case "instance", "persistent", "temporary":
		default:
			return nil, &inputError{fmt.Sprintf("%s: durability must be instance, persistent or temporary, not %q", where, o.Durability)}
		}
		if strings.TrimSpace(o.Key) == "" {
			return nil, &inputError{where + ": needs a key"}
		}
		if o.Unset == (o.Value != "") {
			return nil, &inputError{where + ": needs a value, or unset = true, not both"}
		}
		out = append(out, storageOverride{
			durability: o.Durability, key: o.Key, value: o.Value, unset: o.Unset,
			source: fmt.Sprintf("%s (%s:%s)", where, o.Durability, o.Key),
		})
	}
	return out, nil
}
