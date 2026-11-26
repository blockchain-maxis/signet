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
	"sort"
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
	return t.runIn("", name, args...)
}

// runIn is run in dir; "" is the working directory.
func (t Tools) runIn(dir, name string, args ...string) ([]byte, error) {
	if t.Run != nil {
		return t.Run(name, args...)
	}
	var stderr bytes.Buffer
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
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
// installed for the toolchain that builds the crate at dir, which a
// rust-toolchain.toml above it can pin to another than the working
// directory's.
func CheckWasmTarget(t Tools, dir string) error {
	if _, err := t.lookPath("rustup"); err != nil {
		return configuration("rustup is not on PATH, so the %s target cannot be checked: install Rust with rustup (https://rustup.rs)", WasmTarget)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		dir = "" // FindCrate says what is wrong with it
	}
	out, err := t.runIn(dir, "rustup", "target", "list", "--installed")
	if err != nil {
		return configuration("rustup target list --installed failed: %v", err)
	}
	if !slices.Contains(strings.Fields(string(out)), WasmTarget) {
		return configuration("the %s Rust target is not installed for the toolchain that builds %s: rustup target add %s (run there)", WasmTarget, displayDir(dir), WasmTarget)
	}
	return nil
}

// Crate is the contract crate signet dev builds.
type Crate struct {
	Name         string
	ManifestPath string
	// TargetDir is cargo's target directory for the crate's workspace.
	TargetDir string
	// WorkspaceRoot holds the workspace Cargo.toml and Cargo.lock.
	WorkspaceRoot string
	// LocalDeps holds directories of local packages the contract depends on, transitively.
	LocalDeps []string
}

type rawPackage struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Source       *string `json:"source"`
	ManifestPath string  `json:"manifest_path"`
	Targets      []struct {
		CrateTypes []string `json:"crate_types"`
	} `json:"targets"`
	Dependencies []struct {
		Name   string  `json:"name"`
		Source *string `json:"source"`
		Path   string  `json:"path"`
	} `json:"dependencies"`
}

type rawResolveNode struct {
	ID           string   `json:"id"`
	Dependencies []string `json:"dependencies"`
	Deps         []struct {
		Name string `json:"name"`
		Pkg  string `json:"pkg"`
	} `json:"deps"`
}

type rawResolve struct {
	Nodes []rawResolveNode `json:"nodes"`
}

// FindCrate is preflight step 4: path holds a Cargo.toml with a cdylib
// crate (the one named pkg, in a workspace with several).
func FindCrate(t Tools, path, pkg string) (Crate, error) {
	manifest := filepath.Join(path, "Cargo.toml")
	if _, err := os.Stat(manifest); err != nil {
		return Crate{}, configuration("--path %s has no Cargo.toml: point it at the contract's crate directory", path)
	}
	out, err := t.run("cargo", "metadata", "--offline", "--format-version", "1", "--manifest-path", manifest)
	if err != nil {
		out, err = t.run("cargo", "metadata", "--format-version", "1", "--manifest-path", manifest)
	}
	if err != nil {
		out, err = t.run("cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest)
	}
	if err != nil {
		return Crate{}, configuration("cargo metadata could not read %s: %v", manifest, err)
	}
	var meta struct {
		TargetDirectory string       `json:"target_directory"`
		WorkspaceRoot   string       `json:"workspace_root"`
		Packages        []rawPackage `json:"packages"`
		Resolve         *rawResolve  `json:"resolve"`
		// WorkspaceMembers are the package IDs of the workspace's own
		// crates. Without --no-deps, packages lists every dependency in
		// the graph too, and only a member can be the contract.
		WorkspaceMembers []string `json:"workspace_members"`
	}
	if err := json.Unmarshal(out, &meta); err != nil {
		return Crate{}, configuration("cargo metadata for %s is unreadable: %v", manifest, err)
	}
	var contracts []Crate
	var contractPkgs []rawPackage
	for _, p := range meta.Packages {
		if len(meta.WorkspaceMembers) > 0 && !slices.Contains(meta.WorkspaceMembers, p.ID) {
			continue
		}
		for _, target := range p.Targets {
			if slices.Contains(target.CrateTypes, "cdylib") {
				contracts = append(contracts, Crate{
					Name:          p.Name,
					ManifestPath:  p.ManifestPath,
					TargetDir:     meta.TargetDirectory,
					WorkspaceRoot: meta.WorkspaceRoot,
				})
				contractPkgs = append(contractPkgs, p)
				break
			}
		}
	}
	names := make([]string, len(contracts))
	for i, c := range contracts {
		names[i] = c.Name
	}
	selectedIndex := -1
	switch {
	case len(contracts) == 0:
		return Crate{}, configuration("%s has no cdylib crate: a contract's Cargo.toml needs [lib] crate-type = [\"cdylib\"]", manifest)
	case pkg != "":
		for i, c := range contracts {
			if c.Name == pkg {
				selectedIndex = i
				break
			}
		}
		if selectedIndex == -1 {
			return Crate{}, configuration("%s has no contract crate %q; it has %s", manifest, pkg, strings.Join(names, ", "))
		}
	case len(contracts) > 1:
		return Crate{}, configuration("%s has several contract crates (%s): pick one with --package", manifest, strings.Join(names, ", "))
	default:
		selectedIndex = 0
	}

	selectedCrate := contracts[selectedIndex]
	selectedRaw := contractPkgs[selectedIndex]
	selectedCrate.LocalDeps = collectLocalDeps(meta.Packages, meta.Resolve, selectedRaw)
	return selectedCrate, nil
}

func collectLocalDeps(packages []rawPackage, resolve *rawResolve, rootPkg rawPackage) []string {
	crateDir := filepath.Dir(rootPkg.ManifestPath)
	pkgByID := make(map[string]rawPackage, len(packages))
	pkgByName := make(map[string]rawPackage, len(packages))
	for _, p := range packages {
		if p.ID != "" {
			pkgByID[p.ID] = p
		}
		pkgByName[p.Name] = p
	}

	depDirs := make(map[string]bool)

	if resolve != nil && len(resolve.Nodes) > 0 {
		nodeByID := make(map[string]rawResolveNode, len(resolve.Nodes))
		for _, n := range resolve.Nodes {
			nodeByID[n.ID] = n
		}

		visited := map[string]bool{}
		rootID := rootPkg.ID
		if rootID == "" {
			for _, n := range resolve.Nodes {
				if strings.HasPrefix(n.ID, rootPkg.Name+" ") || n.ID == rootPkg.Name {
					rootID = n.ID
					break
				}
			}
		}

		if rootID != "" {
			queue := []string{rootID}
			visited[rootID] = true
			for len(queue) > 0 {
				currID := queue[0]
				queue = queue[1:]

				node, ok := nodeByID[currID]
				if !ok {
					continue
				}
				allDeps := append([]string{}, node.Dependencies...)
				for _, d := range node.Deps {
					if d.Pkg != "" {
						allDeps = append(allDeps, d.Pkg)
					}
				}
				for _, depID := range allDeps {
					if visited[depID] {
						continue
					}
					visited[depID] = true
					depPkg, ok := pkgByID[depID]
					if !ok {
						for _, p := range packages {
							if strings.HasPrefix(depID, p.Name+" ") || p.Name == depID {
								depPkg = p
								ok = true
								break
							}
						}
					}
					if ok && depPkg.Source == nil {
						d := filepath.Dir(depPkg.ManifestPath)
						if d != crateDir {
							depDirs[d] = true
						}
						queue = append(queue, depID)
					}
				}
			}
		}
	}

	// Also traverse via package.dependencies to support path dependencies when resolve is omitted or incomplete.
	visitedByName := map[string]bool{rootPkg.Name: true}
	queue := []string{rootPkg.Name}
	for len(queue) > 0 {
		currName := queue[0]
		queue = queue[1:]

		p, ok := pkgByName[currName]
		if !ok {
			continue
		}
		for _, dep := range p.Dependencies {
			if dep.Source != nil {
				continue
			}
			var d string
			if depPkg, ok := pkgByName[dep.Name]; ok && depPkg.Source == nil {
				d = filepath.Dir(depPkg.ManifestPath)
				if !visitedByName[depPkg.Name] {
					visitedByName[depPkg.Name] = true
					queue = append(queue, depPkg.Name)
				}
			} else if dep.Path != "" {
				d = filepath.Clean(dep.Path)
				if strings.HasSuffix(d, "Cargo.toml") {
					d = filepath.Dir(d)
				}
			}
			if d != "" && d != crateDir {
				depDirs[d] = true
			}
		}
	}

	result := make([]string, 0, len(depDirs))
	for d := range depDirs {
		result = append(result, d)
	}
	sort.Strings(result)
	return result
}

func displayDir(dir string) string {
	if dir == "" {
		return "the crate"
	}
	return dir
}
