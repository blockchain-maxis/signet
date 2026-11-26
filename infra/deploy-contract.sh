#!/usr/bin/env bash
# Deploy + initialize the Signet Identity Registry to a Stellar network.
#
# Usage:
#   STELLAR_ACCOUNT=<deployer-key-name> NETWORK=testnet ./infra/deploy-contract.sh
#
# Environment:
#   STELLAR_ACCOUNT     stellar CLI identity that signs the deploy (default: deployer)
#   NETWORK             testnet | mainnet | <other> — selects the RPC_URL and
#                       NETWORK_PASSPHRASE defaults below (default: testnet)
#   RPC_URL             Soroban RPC endpoint. Default for testnet:
#                       https://soroban-testnet.stellar.org. Required for
#                       mainnet (there is no public mainnet RPC host) and for
#                       any other network.
#   NETWORK_PASSPHRASE  network passphrase. Defaults for testnet and mainnet;
#                       required for any other network.
#   ADMIN_ADDRESS       registry admin (default: the deployer's address; it
#                       must be the deployer, see below)
#
# Every network call passes --rpc-url and --network-passphrase explicitly
# rather than `--network "$NETWORK"`: on stellar CLI 25.2.0 the alias fails
# with "rpc-url is used but network passphrase is missing"
# (docs/TROUBLESHOOTING.md §1).
#
# Requires the `stellar` CLI (https://stellar.org) with a configured identity:
#   stellar keys generate deployer --network testnet --fund
#
# Prints the sha256 of the deployed wasm (verified against the code fetched
# back from the network) and the contract id. Set the id as
# NEXT_PUBLIC_IDENTITY_REGISTRY_ID (web) and INDEXER_REGISTRY_CONTRACT_ID
# (indexer).
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
ACCOUNT="${STELLAR_ACCOUNT:-deployer}"
ADMIN="${ADMIN_ADDRESS:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="$ROOT/packages/contracts"
WASM="$CONTRACTS/target/wasm32v1-none/release/identity_registry.wasm"
WASM_OPT="${WASM%.wasm}.optimized.wasm"

case "$NETWORK" in
  testnet)
    RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
    NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
    ;;
  mainnet)
    RPC_URL="${RPC_URL:-}"
    NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Public Global Stellar Network ; September 2015}"
    ;;
  *)
    RPC_URL="${RPC_URL:-}"
    NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-}"
    ;;
esac

if [ -z "$RPC_URL" ]; then
  echo "✗ RPC_URL is not set and NETWORK=$NETWORK has no default." >&2
  echo "  Mainnet has no public Soroban RPC host: set RPC_URL to your provider's endpoint." >&2
  exit 1
fi
if [ -z "$NETWORK_PASSPHRASE" ]; then
  echo "✗ NETWORK_PASSPHRASE is not set and NETWORK=$NETWORK has no default." >&2
  exit 1
fi

NET_ARGS=(--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

DEPLOYER_ADDRESS="$(stellar keys address "$ACCOUNT")"

# Default the admin to the deployer's own address if not provided.
if [ -z "$ADMIN" ]; then
  ADMIN="$DEPLOYER_ADDRESS"
fi

# `initialize` calls `admin.require_auth()` and this script signs it as
# $ACCOUNT, so it can only succeed when the admin *is* the deployer. Checked
# before anything is deployed: a contract deployed but left uninitialized is
# claimable by whoever calls `initialize` first, so failing after the deploy
# would hand the registry to a stranger.
if [ "$ADMIN" != "$DEPLOYER_ADDRESS" ]; then
  echo "✗ ADMIN_ADDRESS ($ADMIN) is not the deploying account ($DEPLOYER_ADDRESS)." >&2
  echo "  initialize requires the admin's signature, which only '$ACCOUNT' can provide." >&2
  echo "  Deploy as the intended admin, then hand over with set_admin." >&2
  exit 1
fi

echo "→ Building wasm (release)…"
( cd "$CONTRACTS" && stellar contract build )

if [ ! -f "$WASM" ]; then
  echo "✗ build did not produce $WASM" >&2
  exit 1
fi

# `optimize` writes a separate file and leaves $WASM untouched, so name the
# output explicitly and deploy that. A stale file from an earlier run must not
# stand in for a failed optimize, hence the rm and the existence check; any
# failure (including a CLI without the subcommand) stops the deploy.
echo "→ Optimizing…"
rm -f "$WASM_OPT"
stellar contract optimize --wasm "$WASM" --wasm-out "$WASM_OPT"
if [ ! -s "$WASM_OPT" ]; then
  echo "✗ stellar contract optimize did not write $WASM_OPT" >&2
  exit 1
fi
echo "   $(wc -c < "$WASM" | tr -d ' ') bytes → $(wc -c < "$WASM_OPT" | tr -d ' ') bytes"

WASM_SHA256="$(sha256_of "$WASM_OPT")"
echo "   wasm sha256: $WASM_SHA256"

echo "→ Deploying to $NETWORK ($RPC_URL) as '$ACCOUNT'…"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM_OPT" \
  --source "$ACCOUNT" \
  "${NET_ARGS[@]}")"
echo "   contract id: $CONTRACT_ID"

# Initialize immediately. The window between these two transactions is the one
# an attacker would race for; `admin.require_auth()` closes it, but a short
# window is still better than a long one. That is also why the on-chain hash
# check below runs after initialize rather than before it.
echo "→ initialize(admin=$ADMIN)…"
if ! stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ACCOUNT" \
  "${NET_ARGS[@]}" \
  -- initialize --admin "$ADMIN"; then
  {
    echo
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "!!  CONTRACT $CONTRACT_ID"
    echo "!!  WAS DEPLOYED BUT NOT INITIALIZED."
    echo "!!  Whoever calls initialize first becomes its admin. Retry NOW:"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo
    printf '  stellar contract invoke --id %q --source %q --rpc-url %q --network-passphrase %q -- initialize --admin %q\n' \
      "$CONTRACT_ID" "$ACCOUNT" "$RPC_URL" "$NETWORK_PASSPHRASE" "$ADMIN"
    echo
    echo "  If someone else initialized it first, abandon this contract id and deploy again."
  } >&2
  exit 1
fi

# Check that the code on-chain is the file built above.
echo "→ Verifying on-chain wasm…"
FETCH_DIR="$(mktemp -d)"
trap 'rm -rf "$FETCH_DIR"' EXIT
stellar contract fetch \
  --id "$CONTRACT_ID" \
  --out-file "$FETCH_DIR/onchain.wasm" \
  "${NET_ARGS[@]}"
ONCHAIN_SHA256="$(sha256_of "$FETCH_DIR/onchain.wasm")"
if [ "$ONCHAIN_SHA256" != "$WASM_SHA256" ]; then
  echo "✗ on-chain wasm for $CONTRACT_ID has sha256 $ONCHAIN_SHA256," >&2
  echo "  but the deployed file $WASM_OPT has sha256 $WASM_SHA256." >&2
  echo "  Do not publish this contract id." >&2
  exit 1
fi
echo "   on-chain sha256 matches"

echo
echo "✅ Deployed and initialized."
echo "   wasm sha256: $WASM_SHA256"
echo "   Set these env vars:"
echo "   NEXT_PUBLIC_IDENTITY_REGISTRY_ID=$CONTRACT_ID"
echo "   INDEXER_REGISTRY_CONTRACT_ID=$CONTRACT_ID"
