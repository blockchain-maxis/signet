// Command fakedevtools stands in for cargo and rustup in signet dev's tests
// (#563), acting as whichever its executable is named.
//
//   - cargo metadata …: a workspace of one crate, FAKECARGO_PACKAGE
//     (default identity-registry), a cdylib unless FAKECARGO_NO_CDYLIB is set.
//     FAKECARGO_PATH_DEPS lists path dependencies' manifests (outside the
//     workspace's members); FAKECARGO_DEP_CDYLIB gives them a cdylib target.
//   - rustup target list --installed: FAKERUSTUP_TARGETS, one per line
//     (default wasm32v1-none).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	args := os.Args[1:]
	switch {
	case name == "cargo" && len(args) > 0 && args[0] == "metadata":
		cargoMetadata(args[1:])
	case name == "cargo" && len(args) > 0 && args[0] == "--version":
		fmt.Println("cargo 1.97.0 (fake)")
	case name == "rustup" && strings.Join(args, " ") == "target list --installed":
		targets := os.Getenv("FAKERUSTUP_TARGETS")
		if targets == "" {
			targets = "wasm32v1-none\nx86_64-unknown-linux-gnu"
		}
		fmt.Println(targets)
	default:
		fmt.Fprintf(os.Stderr, "fakedevtools: unsupported %s %s\n", name, strings.Join(args, " "))
		os.Exit(2)
	}
}

func cargoMetadata(args []string) {
	manifest := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--manifest-path" {
			manifest = args[i+1]
		}
	}
	pkg := os.Getenv("FAKECARGO_PACKAGE")
	if pkg == "" {
		pkg = "identity-registry"
	}
	crateTypes := []string{"cdylib", "rlib"}
	if os.Getenv("FAKECARGO_NO_CDYLIB") != "" {
		crateTypes = []string{"rlib"}
	}
	dir := filepath.Dir(manifest)

	packages := []any{map[string]any{
		"name":          pkg,
		"id":            pkg + " 0.1.0",
		"manifest_path": manifest,
		"targets":       []any{map[string]any{"name": strings.ReplaceAll(pkg, "-", "_"), "crate_types": crateTypes}},
	}}
	var resolveNodes []any
	var contractNodeDeps []string

	if pathDeps := os.Getenv("FAKECARGO_PATH_DEPS"); pathDeps != "" {
		var contractDeps []any
		depCrateTypes := []string{"rlib"}
		if os.Getenv("FAKECARGO_DEP_CDYLIB") != "" {
			depCrateTypes = []string{"cdylib", "rlib"}
		}
		for _, depManifest := range strings.Split(pathDeps, string(filepath.ListSeparator)) {
			depManifest = strings.TrimSpace(depManifest)
			if depManifest == "" {
				continue
			}
			depDir := filepath.Dir(depManifest)
			depName := filepath.Base(depDir)
			depID := depName + " 0.1.0"
			contractDeps = append(contractDeps, map[string]any{
				"name":   depName,
				"source": nil,
				"req":    "*",
				"path":   depDir,
			})
			packages = append(packages, map[string]any{
				"name":          depName,
				"id":            depID,
				"source":        nil,
				"manifest_path": depManifest,
				"targets":       []any{map[string]any{"name": depName, "crate_types": depCrateTypes}},
			})
			resolveNodes = append(resolveNodes, map[string]any{
				"id":           depID,
				"dependencies": []string{},
			})
			contractNodeDeps = append(contractNodeDeps, depID)
		}
		packages[0].(map[string]any)["dependencies"] = contractDeps
	}

	resolveNodes = append([]any{map[string]any{
		"id":           pkg + " 0.1.0",
		"dependencies": contractNodeDeps,
	}}, resolveNodes...)

	out, _ := json.Marshal(map[string]any{
		"target_directory":  filepath.Join(dir, "target"),
		"workspace_root":    dir,
		"workspace_members": []string{pkg + " 0.1.0"},
		"packages":          packages,
		"resolve": map[string]any{
			"nodes": resolveNodes,
		},
	})
	fmt.Println(string(out))
}
