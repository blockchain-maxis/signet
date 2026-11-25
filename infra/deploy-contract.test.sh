#!/usr/bin/env bash
# Tests for infra/deploy-contract.sh against a fake `stellar` on PATH that logs
# every invocation (same idea as cli/internal/keys/testdata/fakestellar). No
# network, no Rust toolchain.
#
#   bash infra/deploy-contract.test.sh
# The assertion helpers (said, logged, not) are only called through check "$@".
# shellcheck disable=SC2317
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
fail() { echo "  ✗ $*" >&2; FAILS=$((FAILS + 1)); }
pass() { echo "  ✓ $*"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# ── fake stellar ──────────────────────────────────────────────────────────
# One log line per call; arguments separated by a TAB so a value with spaces
# (the passphrase) stays one field.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/stellar" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
( IFS=$'\t'; printf '%s\n' "$*" ) >> "$FAKESTELLAR_LOG"

flag() { # value of --name in "$@"
  local name="$1"; shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "$name" ]; then echo "$2"; return; fi
    shift
  done
}

case "$1 ${2:-}" in
  "keys address") echo "GDEPLOYERFAKEADDRESS" ;;
  "contract build")
    mkdir -p target/wasm32v1-none/release
    printf 'unoptimized-wasm-bytes-unoptimized-wasm-bytes' > target/wasm32v1-none/release/identity_registry.wasm
    ;;
  "contract optimize")
    out="$(flag --wasm-out "$@")"
    [ -n "$out" ] || { echo "fake: optimize without --wasm-out leaves --wasm alone" >&2; exit 0; }
    printf 'optimized-wasm' > "$out"
    ;;
  "contract deploy")
    wasm="$(flag --wasm "$@")"
    cp "$wasm" "$FAKESTELLAR_STATE/deployed.wasm"
    echo "CFAKECONTRACTID"
    ;;
  "contract invoke")
    if [ -n "${FAKESTELLAR_INVOKE_FAIL:-}" ]; then
      echo "error: transaction simulation failed" >&2
      exit 1
    fi
    ;;
  "contract fetch")
    out="$(flag --out-file "$@")"
    if [ -n "${FAKESTELLAR_FETCH_TAMPER:-}" ]; then
      printf 'something-else' > "$out"
    else
      cp "$FAKESTELLAR_STATE/deployed.wasm" "$out"
    fi
    ;;
  *) echo "fake: unsupported invocation: $*" >&2; exit 2 ;;
esac
FAKE
chmod +x "$WORK/bin/stellar"

# Run the script from a throwaway copy of the repo layout so the fake build
# never writes into the real packages/contracts/target.
run_case() { # name, then env assignments; sets CASE_DIR, OUT, STATUS
  local name="$1"; shift
  CASE_DIR="$WORK/$name"
  mkdir -p "$CASE_DIR/infra" "$CASE_DIR/packages/contracts" "$CASE_DIR/state"
  cp "$HERE/deploy-contract.sh" "$CASE_DIR/infra/"
  : > "$CASE_DIR/stellar.log"
  set +e
  OUT="$(env PATH="$WORK/bin:$PATH" \
    FAKESTELLAR_LOG="$CASE_DIR/stellar.log" \
    FAKESTELLAR_STATE="$CASE_DIR/state" \
    "$@" bash "$CASE_DIR/infra/deploy-contract.sh" 2>&1)"
  STATUS=$?
  set -e
}

TAB=$'\t'
assert_network_flags() { # log, rpc, passphrase; sets CALLS
  local log="$1" rpc="$2" pass="$3" line
  CALLS=0
  while IFS= read -r line; do
    case "$line" in
      "contract${TAB}deploy"*|"contract${TAB}invoke"*|"contract${TAB}fetch"*) ;;
      *) continue ;;
    esac
    CALLS=$((CALLS + 1))
    case "$TAB$line$TAB" in
      *"$TAB--rpc-url$TAB$rpc$TAB"*) ;;
      *) fail "network call without --rpc-url $rpc: ${line//$TAB/ }" ;;
    esac
    case "$TAB$line$TAB" in
      *"$TAB--network-passphrase$TAB$pass$TAB"*) ;;
      *) fail "network call without --network-passphrase '$pass': ${line//$TAB/ }" ;;
    esac
    case "$TAB$line$TAB" in
      *"$TAB--network$TAB"*) fail "network call still uses the --network alias: ${line//$TAB/ }" ;;
    esac
  done < "$log"
  [ "$CALLS" -gt 0 ] || fail "no network calls were logged"
}
# check <description> <command...>: pass when the command succeeds; on failure
# also dump the script's output so CI shows what it printed.
check() {
  local what="$1"; shift
  if "$@"; then pass "$what"; else fail "$what"; echo "$OUT" >&2; fi
}
said() { grep -qF -- "$1" <<< "$OUT"; }
logged() { grep -q "^contract${TAB}$1" "$CASE_DIR/stellar.log"; }
not() { ! "$@"; }

# ── 1. testnet happy path ─────────────────────────────────────────────────
echo "testnet deploy"
run_case ok NETWORK=testnet STELLAR_ACCOUNT=deployer
check "exits 0 (got $STATUS)" test "$STATUS" -eq 0

assert_network_flags "$CASE_DIR/stellar.log" \
  "https://soroban-testnet.stellar.org" "Test SDF Network ; September 2015"
check "deploy, invoke and fetch all carry --rpc-url and --network-passphrase ($CALLS calls)" \
  test "$CALLS" -eq 3

opt="$CASE_DIR/packages/contracts/target/wasm32v1-none/release/identity_registry.optimized.wasm"
deploy_line="$(grep "^contract${TAB}deploy" "$CASE_DIR/stellar.log" || true)"
case "$TAB$deploy_line$TAB" in
  *"$TAB--wasm$TAB$opt$TAB"*) pass "deploys the optimized file" ;;
  *) fail "deploy did not use $opt: ${deploy_line//$TAB/ }" ;;
esac

want="$(sha256_of "$opt")"
check "prints the optimized file's sha256 ($want)" said "wasm sha256: $want"
check "prints the contract id" said "NEXT_PUBLIC_IDENTITY_REGISTRY_ID=CFAKECONTRACTID"

# ── 2. initialize fails after the deploy ──────────────────────────────────
echo "initialize failure"
run_case initfail NETWORK=testnet STELLAR_ACCOUNT=deployer FAKESTELLAR_INVOKE_FAIL=1
check "exits non-zero (got $STATUS)" test "$STATUS" -ne 0
check "prints the not-initialized warning" said "DEPLOYED BUT NOT INITIALIZED"
check "warning names the contract id" said "CONTRACT CFAKECONTRACTID"
retry='stellar contract invoke --id CFAKECONTRACTID --source deployer --rpc-url https://soroban-testnet.stellar.org --network-passphrase Test\ SDF\ Network\ \;\ September\ 2015 -- initialize --admin GDEPLOYERFAKEADDRESS'
check "prints the exact retry command" said "$retry"
check "does not go on to fetch" not logged fetch

# ── 3. on-chain code differs from the built file ──────────────────────────
echo "on-chain hash mismatch"
run_case tamper NETWORK=testnet STELLAR_ACCOUNT=deployer FAKESTELLAR_FETCH_TAMPER=1
check "exits non-zero (got $STATUS)" test "$STATUS" -ne 0
check "reports the mismatch" said "on-chain wasm for CFAKECONTRACTID has sha256"
check "does not print success" not said "Deployed and initialized"

# ── 4. mainnet: passphrase default, RPC_URL required ──────────────────────
echo "mainnet"
run_case mainnet-norpc NETWORK=mainnet STELLAR_ACCOUNT=deployer RPC_URL=
check "exits non-zero without RPC_URL (got $STATUS)" test "$STATUS" -ne 0
check "says RPC_URL is missing" said "RPC_URL is not set"
check "calls stellar only after validating RPC_URL" test ! -s "$CASE_DIR/stellar.log"

run_case mainnet NETWORK=mainnet STELLAR_ACCOUNT=deployer RPC_URL=https://rpc.example.test
check "exits 0 with RPC_URL (got $STATUS)" test "$STATUS" -eq 0
assert_network_flags "$CASE_DIR/stellar.log" \
  "https://rpc.example.test" "Public Global Stellar Network ; September 2015"
check "uses RPC_URL and the mainnet passphrase ($CALLS calls)" test "$CALLS" -eq 3

echo
if [ "$FAILS" -gt 0 ]; then
  echo "✗ $FAILS assertion(s) failed" >&2
  exit 1
fi
echo "✅ deploy-contract.sh tests passed"
