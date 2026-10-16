#!/usr/bin/env bash
#
# Rebuild sandbox fixture contracts from source.
#
#   sandbox/fixtures/build.sh
#
# Writes compiled WASM artifacts to sandbox/fixtures/wasm/.
# Uses the pinned toolchain in sandbox/fixtures/rust-toolchain.toml and
# release profile in sandbox/fixtures/Cargo.toml.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WASM_DIR="$HERE/wasm"

command -v stellar >/dev/null 2>&1 || { echo "error: stellar CLI not on PATH (install stellar-cli >= 25.2.0)" >&2; exit 1; }

mkdir -p "$WASM_DIR"

cd "$HERE"
stellar contract build --locked --out-dir "$WASM_DIR"
