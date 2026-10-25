// Command fakedevtools stands in for cargo and rustup in signet dev's tests
// (#563), acting as whichever its executable is named.
//
//   - cargo metadata …: a workspace of one crate, FAKECARGO_PACKAGE
//     (default identity-registry), a cdylib unless FAKECARGO_NO_CDYLIB is set.
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
	out, _ := json.Marshal(map[string]any{
		"target_directory": filepath.Join(dir, "target"),
		"workspace_root":   dir,
		"packages": []any{map[string]any{
			"name":          pkg,
			"manifest_path": manifest,
			"targets":       []any{map[string]any{"name": strings.ReplaceAll(pkg, "-", "_"), "crate_types": crateTypes}},
		}},
	})
	fmt.Println(string(out))
}
