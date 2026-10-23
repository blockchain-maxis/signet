#!/usr/bin/env bash
# Verifies a staged CLI release before anything is published. Every
# `@signet/cli-*` platform package must hold `signet` and `signet-simulator`
# side by side in `bin/`, every per-platform archive must hold exactly those
# two at its top level, and `checksums.txt` must cover one archive per platform
# and verify.
#
# Shared by .github/workflows/release-cli.yml (real release) and
# .github/workflows/release-cli-dry-run.yml (PR rehearsal) so both enforce the
# same invariant: a release ships both binaries built from the same tag, never
# one without the other (docs/CLI_RUST_BRIDGE.md section 5).
#
# Env:
#   VERSION   required  release version, no `cli-v` prefix
#   NPM_ROOT  optional  default: cli/npm
#   DIST      optional  default: cli/dist
set -euo pipefail

: "${VERSION:?VERSION is required (e.g. VERSION=0.1.0)}"
NPM_ROOT="${NPM_ROOT:-cli/npm}"
DIST="${DIST:-cli/dist}"

fail() {
  echo "::error::$*" >&2
  exit 1
}

shopt -s nullglob

packages=()
for dir in "$NPM_ROOT"/cli-*/; do
  [[ -f "${dir}package.json" ]] && packages+=("$dir")
done
[[ ${#packages[@]} -gt 0 ]] || fail "no platform packages under ${NPM_ROOT}"

for dir in "${packages[@]}"; do
  pkg="$(basename "$dir")"
  bin="${dir}bin"

  exe=""
  [[ -f "${bin}/signet.exe" ]] && exe=".exe"

  for name in "signet${exe}" "signet-simulator${exe}"; do
    [[ -s "${bin}/${name}" ]] || fail "${pkg}: missing or empty bin/${name}"
  done
  if cmp -s "${bin}/signet${exe}" "${bin}/signet-simulator${exe}"; then
    fail "${pkg}: bin/signet${exe} and bin/signet-simulator${exe} are identical"
  fi

  ext="tar.gz"
  [[ "$exe" == ".exe" ]] && ext="zip"
  archive="${DIST}/signet-${VERSION}-${pkg}.${ext}"
  [[ -f "$archive" ]] || fail "${pkg}: missing archive ${archive}"

  if [[ "$ext" == "zip" ]]; then
    listing="$(unzip -Z1 "$archive" | sort | tr '\n' ' ')"
  else
    listing="$(tar -tzf "$archive" | sort | tr '\n' ' ')"
  fi
  wanted="$(printf '%s\n' "signet${exe}" "signet-simulator${exe}" | sort | tr '\n' ' ')"
  [[ "$listing" == "$wanted" ]] ||
    fail "${archive}: holds '${listing}', expected '${wanted}'"

  echo "ok ${pkg}: bin/ and ${archive##*/} hold both binaries"
done

archive_count=0
for archive in "$DIST"/signet-"${VERSION}"-*.tar.gz "$DIST"/signet-"${VERSION}"-*.zip; do
  [[ -f "$archive" ]] && archive_count=$((archive_count + 1))
done
[[ "$archive_count" -eq "${#packages[@]}" ]] ||
  fail "found ${archive_count} archives for ${#packages[@]} platform packages"

checksum_lines="$(wc -l < "${DIST}/checksums.txt" | tr -d ' ')"
[[ "$checksum_lines" -eq "${#packages[@]}" ]] ||
  fail "checksums.txt has ${checksum_lines} lines, expected ${#packages[@]}"
(cd "$DIST" && sha256sum -c checksums.txt > /dev/null)

echo "verified ${#packages[@]} platform packages and ${archive_count} archives"
