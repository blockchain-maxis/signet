// Package visualise runs the visualiser bundle (#544) in goja, a pure-Go
// JavaScript engine, so `signet visualise` (#578) draws exactly what the
// web app draws without Node, a browser or cgo.
package visualise

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/dop251/goja"
)

//go:embed bundle/visualiser.js
var bundleSource string

// Limit is how long one render may run before it is interrupted.
var Limit = 10 * time.Second

// ErrTimeout is a render that ran past Limit.
var ErrTimeout = errors.New("the visualiser ran past its time limit")

// Input is signetVisualise's argument.
type Input struct {
	SpecJSON json.RawMessage `json:"specJson"`
	Theme    string          `json:"theme"` // dark, light or auto
	Address  string          `json:"address,omitempty"`
	Network  string          `json:"network,omitempty"`
}

// Decision is the visualiser's worth-drawing decision: draw, too-simple or
// too-large, with its counts and reason.
type Decision struct {
	Kind string `json:"kind"`
	// Rest holds the decision's other fields as the bundle gave them.
	Rest map[string]any `json:"-"`
}

// UnmarshalJSON keeps every field of the decision.
func (d *Decision) UnmarshalJSON(b []byte) error {
	var all map[string]any
	if err := json.Unmarshal(b, &all); err != nil {
		return err
	}
	d.Kind, _ = all["kind"].(string)
	delete(all, "kind")
	d.Rest = all
	return nil
}

// MarshalJSON writes the decision back whole.
func (d Decision) MarshalJSON() ([]byte, error) {
	all := map[string]any{"kind": d.Kind}
	for k, v := range d.Rest {
		all[k] = v
	}
	return json.Marshal(all)
}

// Output is signetVisualise's result.
type Output struct {
	SVG      string   `json:"svg"`
	Decision Decision `json:"decision"`
	WasmHash string   `json:"wasmHash"`
}

var (
	compileOnce sync.Once
	program     *goja.Program
	compileErr  error
)

// Render draws a contract's diagram from its SpecJson.
func Render(in Input) (Output, error) {
	return render(in, func() (*goja.Program, error) {
		compileOnce.Do(func() { program, compileErr = goja.Compile("visualiser.js", bundleSource, true) })
		return program, compileErr
	})
}

func render(in Input, load func() (*goja.Program, error)) (Output, error) {
	prog, err := load()
	if err != nil {
		return Output{}, fmt.Errorf("the visualiser bundle does not compile: %w", err)
	}
	payload, err := json.Marshal(in)
	if err != nil {
		return Output{}, err
	}
	vm := goja.New()
	timer := time.AfterFunc(Limit, func() { vm.Interrupt(ErrTimeout) })
	defer timer.Stop()
	if _, err := vm.RunProgram(prog); err != nil {
		return Output{}, wrap(err)
	}
	if err := vm.Set("__input", string(payload)); err != nil {
		return Output{}, err
	}
	v, err := vm.RunString("JSON.stringify(signetVisualise(JSON.parse(__input)))")
	if err != nil {
		return Output{}, wrap(err)
	}
	var out Output
	if err := json.Unmarshal([]byte(v.String()), &out); err != nil {
		return Output{}, fmt.Errorf("the visualiser's answer: %w", err)
	}
	return out, nil
}

func wrap(err error) error {
	var interrupted *goja.InterruptedError
	if errors.As(err, &interrupted) {
		return fmt.Errorf("%w (%s)", ErrTimeout, Limit)
	}
	return fmt.Errorf("the visualiser failed: %w", err)
}
