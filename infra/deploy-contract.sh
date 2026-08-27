#!/usr/bin/env bash
# Deploy + initialize the Signet Identity Registry to a Stellar network.
#
# Usage:
#   STELLAR_ACCOUNT=<deployer-key-name> NETWORK=testnet ./infra/deploy-contract.sh
#
# Requires the `stellar` CLI (https://stellar.org) with a configured identity:
#   stellar keys generate deployer --network testnet --fund
#
# Prints the deployed contract id. Set it as NEXT_PUBLIC_IDENTITY_REGISTRY_ID
# (web) and INDEXER_REGISTRY_CONTRACT_ID (indexer).
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
ACCOUNT="${STELLAR_ACCOUNT:-deployer}"
ADMIN="${ADMIN_ADDRESS:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="$ROOT/packages/contracts"
WASM="$CONTRACTS/target/wasm32v1-none/release/identity_registry.wasm"

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
( cd "$CONTRACTS" && cargo build --target wasm32v1-none --release )

echo "→ Optimizing…"
stellar contract optimize --wasm "$WASM" || true

echo "→ Deploying to $NETWORK as '$ACCOUNT'…"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK")"
echo "   contract id: $CONTRACT_ID"

# Initialize immediately. The window between these two transactions is the one
# an attacker would race for; `admin.require_auth()` closes it, but a short
# window is still better than a long one.
echo "→ initialize(admin=$ADMIN)…"
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize --admin "$ADMIN"

echo
echo "✅ Deployed. Set these env vars:"
echo "   NEXT_PUBLIC_IDENTITY_REGISTRY_ID=$CONTRACT_ID"
echo "   INDEXER_REGISTRY_CONTRACT_ID=$CONTRACT_ID"
