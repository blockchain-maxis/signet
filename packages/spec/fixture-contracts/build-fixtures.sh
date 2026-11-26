#!/usr/bin/env bash
#
# Rebuild every locally-built spec fixture from source.
#
#   build-fixtures.sh          refresh packages/spec/fixtures/*.wasm in place
#   build-fixtures.sh --check  fail if any committed fixture differs (CI)
#
# Prerequisites (also installed by the spec-fixtures CI job): a Rust toolchain
# honouring packages/spec/fixture-contracts/rust-toolchain.toml, stellar-cli
# (only `contract build` is used, never `optimize`), wabt (`wat2wasm`) and
# node (for the corrupt-section generator).
#
# `stellar contract optimize` is deliberately NOT run: optimization rewrites
# the module and would tie every fixture to the CLI version that ran it. The
# committed bytes are exactly what the SDK emitted, so a diff always means a
# source change and never a toolchain repackaging.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
FIXTURES="$HERE/../fixtures"
OUT="$HERE/target/wasm32v1-none/release"
MODE="${1:---build}"

if [ "$MODE" != "--build" ] && [ "$MODE" != "--check" ]; then
  echo "usage: build-fixtures.sh [--build|--check]" >&2
  exit 2
fi

command -v stellar >/dev/null || { echo "error: stellar CLI not on PATH" >&2; exit 1; }
command -v wat2wasm >/dev/null || { echo "error: wat2wasm (wabt) not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "error: node not on PATH" >&2; exit 1; }

# `stellar contract build` resolves its workspace from the process's working
# directory (it has no --manifest-path for a workspace build), not from where
# this script lives. Called from the repo root — which is how the CI step
# invokes it — it would otherwise fail with "could not find Cargo.toml".
cd "$HERE"
stellar contract build --locked
wat2wasm "$HERE/no_spec.wat" -o "$OUT/no_spec.wasm"
node "$HERE/scripts/make-corrupt-section.mjs" \
  "$FIXTURES/identity-registry.wasm" "$OUT/corrupt_section.wasm"

fail=0
for name in types_zoo undocumented events errors_multi upgrade_v1 upgrade_v2 no_spec corrupt_section; do
  built="$OUT/$name.wasm"
  committed="$FIXTURES/$name.wasm"
  if [ "$MODE" = "--build" ]; then
    cp "$built" "$committed"
    echo "refreshed $name.wasm"
  else
    if [ ! -f "$committed" ]; then
      echo "::error::missing committed fixture $committed"
      fail=1
    elif ! cmp -s "$built" "$committed"; then
      echo "::error::$name.wasm differs from a fresh build — rebuild with build-fixtures.sh and commit the result"
      fail=1
    else
      echo "ok $name.wasm"
    fi
  fi
done

exit "$fail"
