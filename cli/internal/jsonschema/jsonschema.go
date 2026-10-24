// Package jsonschema validates JSON against the draft-07 subset the
// sandbox schemas use (sandbox/protocol/schema/v1): type, const, enum,
// properties, required, additionalProperties, items, minItems, minLength,
// minimum, pattern, oneOf, allOf, if/then and local $refs. A schema using any
// other keyword fails validation loudly, so it cannot pass by accident. Tests
// use it to hold Go structs and CLI output to the schemas without a
// dependency.
package jsonschema

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"regexp"
	"strings"
)

// Load reads a schema file.
func Load(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s map[string]any
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return s, nil
}

// Validate checks value (decoded JSON) against schema, whose root holds the
// definitions $refs point at. It returns one message per violation.
func Validate(root map[string]any, schema any, value any) []string {
	v := &validator{root: root}
	return v.validate(schema, value, "$")
}

// validator holds the schema root for local $refs.
type validator struct{ root map[string]any }

var annotations = map[string]bool{"$schema": true, "$id": true, "title": true, "description": true, "definitions": true, "examples": true, "default": true}

func (v *validator) validate(schema any, val any, path string) []string {
	switch s := schema.(type) {
	case bool:
		if !s {
			return []string{path + ": schema false"}
		}
		return nil
	case map[string]any:
		return v.object(s, val, path)
	}
	return []string{path + ": unreadable schema"}
}

func (v *validator) object(s map[string]any, val any, path string) []string {
	var errs []string
	fail := func(format string, a ...any) { errs = append(errs, path+": "+fmt.Sprintf(format, a...)) }

	if ref, ok := s["$ref"].(string); ok {
		name, found := strings.CutPrefix(ref, "#/definitions/")
		if !found {
			return []string{path + ": unsupported $ref " + ref}
		}
		def := v.root["definitions"].(map[string]any)[name]
		return v.validate(def, val, path)
	}

	for k := range s {
		switch k {
		case "type", "const", "enum", "properties", "required", "additionalProperties", "items",
			"minItems", "minLength", "minimum", "pattern", "oneOf", "allOf", "if", "then":
		default:
			if !annotations[k] {
				fail("validator does not implement keyword %q", k)
			}
		}
	}

	if t, ok := s["type"].(string); ok && !hasType(val, t) {
		fail("want %s, got %s", t, jsonType(val))
		return errs
	}
	if c, ok := s["const"]; ok && !reflect.DeepEqual(c, val) {
		fail("want const %v, got %v", c, val)
	}
	if e, ok := s["enum"].([]any); ok {
		found := false
		for _, x := range e {
			found = found || reflect.DeepEqual(x, val)
		}
		if !found {
			fail("%v not in enum %v", val, e)
		}
	}
	if str, ok := val.(string); ok {
		if n, ok := s["minLength"].(float64); ok && float64(len([]rune(str))) < n {
			fail("shorter than %v", n)
		}
		if p, ok := s["pattern"].(string); ok && !regexp.MustCompile(p).MatchString(str) {
			fail("%q does not match %s", str, p)
		}
	}
	if num, ok := val.(float64); ok {
		if n, ok := s["minimum"].(float64); ok && num < n {
			fail("%v below minimum %v", num, n)
		}
	}
	if arr, ok := val.([]any); ok {
		if n, ok := s["minItems"].(float64); ok && float64(len(arr)) < n {
			fail("fewer than %v items", n)
		}
		if items, ok := s["items"]; ok {
			for i, x := range arr {
				errs = append(errs, v.validate(items, x, fmt.Sprintf("%s[%d]", path, i))...)
			}
		}
	}
	if obj, ok := val.(map[string]any); ok {
		props, _ := s["properties"].(map[string]any)
		if req, ok := s["required"].([]any); ok {
			for _, r := range req {
				if _, ok := obj[r.(string)]; !ok {
					fail("missing required %q", r)
				}
			}
		}
		for k, x := range obj {
			if ps, ok := props[k]; ok {
				errs = append(errs, v.validate(ps, x, path+"."+k)...)
			} else if ap, ok := s["additionalProperties"]; ok {
				if b, isBool := ap.(bool); isBool && !b {
					fail("unexpected property %q", k)
				} else if !isBool {
					errs = append(errs, v.validate(ap, x, path+"."+k)...)
				}
			}
		}
	}
	if one, ok := s["oneOf"].([]any); ok {
		matched := 0
		for _, sub := range one {
			if len(v.validate(sub, val, path)) == 0 {
				matched++
			}
		}
		if matched != 1 {
			fail("matches %d of oneOf's %d branches, want exactly 1", matched, len(one))
		}
	}
	if all, ok := s["allOf"].([]any); ok {
		for _, sub := range all {
			errs = append(errs, v.validate(sub, val, path)...)
		}
	}
	if cond, ok := s["if"]; ok && len(v.validate(cond, val, path)) == 0 {
		if then, ok := s["then"]; ok {
			errs = append(errs, v.validate(then, val, path)...)
		}
	}
	return errs
}

func hasType(val any, t string) bool {
	switch t {
	case "object":
		_, ok := val.(map[string]any)
		return ok
	case "array":
		_, ok := val.([]any)
		return ok
	case "string":
		_, ok := val.(string)
		return ok
	case "boolean":
		_, ok := val.(bool)
		return ok
	case "null":
		return val == nil
	case "number":
		_, ok := val.(float64)
		return ok
	case "integer":
		f, ok := val.(float64)
		return ok && f == math.Trunc(f)
	}
	return false
}

func jsonType(val any) string {
	switch val.(type) {
	case nil:
		return "null"
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		return "number"
	}
	return fmt.Sprintf("%T", val)
}
