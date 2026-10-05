#!/usr/bin/env bash
# Builds the signet CLI for every release target, stages each @signet/cli-<platform>
# npm package, writes cli/dist/checksums.txt, and pins the @signet/cli shim.
#
# Shared by .github/workflows/release-cli.yml (real release) and
# .github/workflows/release-cli-dry-run.yml (PR rehearsal) so the two cannot
# drift. It builds, stages and pins only: publishing stays in release-cli.yml.
#
# Go cross-compiles from one host with just GOOS/GOARCH (no cgo, see
# cli/go.mod), so every target is built here in one pass.
#
# Env:
#   VERSION     required  release version, no `cli-v` prefix
#                         (e.g. 0.1.0 or 0.0.0-dryrun.abc1234)
#   COMMIT      optional  commit stamped into the binary (default: git rev-parse HEAD)
#   BUILD_ONLY  optional  space-separated npm package names (e.g. "cli-linux-x64")
#                         to build a subset, for local runs. CI leaves it unset
#                         (all targets). The shim pin step always runs.
#
# Output: cli/dist/<npm_pkg>-<binary>, cli/dist/checksums.txt, staged
# cli/npm/<npm_pkg>/bin/*, and the pinned cli/npm/cli/package.json.
set -euo pipefail

: "${VERSION:?VERSION is required (e.g. VERSION=0.0.0-dryrun.abc1234)}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
COMMIT="${COMMIT:-$(git rev-parse HEAD)}"
BUILD_ONLY="${BUILD_ONLY:-}"

# goos goarch npm_pkg: one line per release target.
targets=(
  "linux   amd64 cli-linux-x64"
  "linux   arm64 cli-linux-arm64"
  "darwin  arm64 cli-darwin-arm64"
  "darwin  amd64 cli-darwin-x64"
  "windows amd64 cli-windows-x64"
)

# Builds ./cmd/signet for goos/goarch into the given path (relative to cli/).
build_signet() {
  local goos="$1" goarch="$2" out="$3"
  (
    cd cli
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build \
      -trimpath \
      -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
      -o "$out" \
      ./cmd/signet
  )
}

# Stages the built binaries of one target into cli/npm/<npm_pkg>. A platform
# package may hold more than one binary (docs/CLI_RUST_BRIDGE.md section 5 adds
# signet-simulator next to signet), so this takes a list of built files rather
# than assuming one. To ship another binary, append its built path to `built`
# in the main loop and let stage-platform-package.mjs accept several binaries;
# only the node call below needs to change.
# Paths are relative to the repo root.
stage_package() {
  local npm_pkg="$1"
  shift
  # stage-platform-package.mjs currently takes exactly one binary.
  node scripts/release/stage-platform-package.mjs "cli/npm/${npm_pkg}" "$1" "${VERSION}"
}

mkdir -p cli/dist
: > cli/dist/checksums.txt

for target in "${targets[@]}"; do
  read -r goos goarch npm_pkg <<< "$target"
  if [[ -n "$BUILD_ONLY" && " $BUILD_ONLY " != *" $npm_pkg "* ]]; then
    continue
  fi
  binname="signet"
  [[ "$goos" == windows ]] && binname="signet.exe"
  out="dist/${npm_pkg}-${binname}"
  echo "::group::build ${goos}/${goarch}"
  build_signet "$goos" "$goarch" "$out"
  built=("cli/${out}")
  # Checksum lines carry the dist/-relative path, as before the extraction.
  (cd cli && sha256sum "$out") >> cli/dist/checksums.txt
  stage_package "$npm_pkg" "${built[@]}"
  echo "::endgroup::"
done
cat cli/dist/checksums.txt

node scripts/release/pin-shim-version.mjs "${VERSION}"
