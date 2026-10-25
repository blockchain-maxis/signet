// Package dev is `signet dev`'s machinery (#563 and on): the preflight that
// finds a missing toolchain piece before anything starts, the build runner,
// the source watcher and the reload cycle.
package dev

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// WasmTarget is the Rust target soroban contracts build for.
const WasmTarget = "wasm32v1-none"

// Tools is how preflight reaches the toolchain, so tests can stand fakes in.
type Tools struct {
	// LookPath finds an executable; exec.LookPath when nil.
	LookPath func(string) (string, error)
	// Run runs a program and returns its stdout; exec when nil.
	Run func(name string, args ...string) ([]byte, error)
}

func (t Tools) lookPath(name string) (string, error) {
	if t.LookPath != nil {
		return t.LookPath(name)
	}
	return exec.LookPath(name)
}

func (t Tools) run(name string, args ...string) ([]byte, error) {
	if t.Run != nil {
		return t.Run(name, args...)
	}
	var stderr bytes.Buffer
	cmd := exec.Command(name, args...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil && stderr.Len() > 0 {
		return out, fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return out, err
}

func configuration(format string, args ...any) error {
	return fmt.Errorf("%w: %s", exitcode.ErrConfiguration, fmt.Sprintf(format, args...))
}

// CheckCargo is preflight step 2: cargo builds the contract.
func CheckCargo(t Tools) error {
	if _, err := t.lookPath("cargo"); err != nil {
		return configuration("cargo is not on PATH: install Rust with rustup (https://rustup.rs), then run signet dev again")
	}
	return nil
}

// CheckWasmTarget is preflight step 3: the wasm32v1-none target is
// installed.
func CheckWasmTarget(t Tools) error {
	if _, err := t.lookPath("rustup"); err != nil {
		return configuration("rustup is not on PATH, so the %s target cannot be checked: install Rust with rustup (https://rustup.rs)", WasmTarget)
	}
	out, err := t.run("rustup", "target", "list", "--installed")
	if err != nil {
		return configuration("rustup target list --installed failed: %v", err)
	}
	if !slices.Contains(strings.Fields(string(out)), WasmTarget) {
		return configuration("the %s Rust target is not installed: rustup target add %s", WasmTarget, WasmTarget)
	}
	return nil
}

// Crate is the contract crate signet dev builds.
type Crate struct {
	Name         string
	ManifestPath string
	// TargetDir is cargo's target directory for the crate's workspace.
	TargetDir string
}

// FindCrate is preflight step 4: path holds a Cargo.toml with a cdylib
// crate (the one named pkg, in a workspace with several).
func FindCrate(t Tools, path, pkg string) (Crate, error) {
	manifest := filepath.Join(path, "Cargo.toml")
	if _, err := os.Stat(manifest); err != nil {
		return Crate{}, configuration("--path %s has no Cargo.toml: point it at the contract's crate directory", path)
	}
	out, err := t.run("cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest)
	if err != nil {
		return Crate{}, configuration("cargo metadata could not read %s: %v", manifest, err)
	}
	var meta struct {
		TargetDirectory string `json:"target_directory"`
		Packages        []struct {
			Name         string `json:"name"`
			ManifestPath string `json:"manifest_path"`
			Targets      []struct {
				CrateTypes []string `json:"crate_types"`
			} `json:"targets"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(out, &meta); err != nil {
		return Crate{}, configuration("cargo metadata for %s is unreadable: %v", manifest, err)
	}
	var contracts []Crate
	for _, p := range meta.Packages {
		for _, target := range p.Targets {
			if slices.Contains(target.CrateTypes, "cdylib") {
				contracts = append(contracts, Crate{Name: p.Name, ManifestPath: p.ManifestPath, TargetDir: meta.TargetDirectory})
				break
			}
		}
	}
	names := make([]string, len(contracts))
	for i, c := range contracts {
		names[i] = c.Name
		if pkg != "" && c.Name == pkg {
			return c, nil
		}
	}
	switch {
	case len(contracts) == 0:
		return Crate{}, configuration("%s has no cdylib crate: a contract's Cargo.toml needs [lib] crate-type = [\"cdylib\"]", manifest)
	case pkg != "":
		return Crate{}, configuration("%s has no contract crate %q; it has %s", manifest, pkg, strings.Join(names, ", "))
	case len(contracts) > 1:
		return Crate{}, configuration("%s has several contract crates (%s): pick one with --package", manifest, strings.Join(names, ", "))
	}
	return contracts[0], nil
}
