#!/usr/bin/env bash
# Replays docs/SANDBOX_TUTORIAL.md against testnet, each command printed with
# its output and exit code: session.log beside this file is one such run.
# It works on a copy of packages/contracts, so the edits the tutorial makes
# never touch the checkout. Needs signet (with signet-simulator), stellar,
# Rust with wasm32v1-none, and testnet's RPC.
#
#   sandbox/testdata/tutorial/run.sh > sandbox/testdata/tutorial/session.log
set -u
root="$(cd "$(dirname "$0")/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/packages"
cp -R "$root/packages/contracts" "$work/packages/"
rm -rf "$work/packages/contracts/target"
cd "$work"

REGISTRY=CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
WALLET=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
OTHER=GC6YINA5FD5MLUI4LKC4JYI5AKAW7BRFJRKNEU3TVRZWYNYN3KKZJR3G
run() { printf '$'; printf ' %q' "$@"; echo; "$@" 2>&1; echo "[exit $?]"; echo; }

date -u +"session started %Y-%m-%dT%H:%M:%SZ"; echo
run signet --version
run signet sandbox fork $REGISTRY
run signet sandbox call $REGISTRY count
run signet sandbox call $REGISTRY resolve --arg handle=alice
run signet sandbox call $REGISTRY claim --arg handle=alice --arg wallet=$WALLET
run signet sandbox call $REGISTRY claim --arg handle=alice --arg wallet=$WALLET --set-storage "persistent:Owner(\"alice\")=\"$OTHER\""
run signet dev init $REGISTRY --path packages/contracts/identity-registry
run signet dev --ci
echo '# edit signet.dev.toml: the count call expects ok'
sed -i.bak 's/^expect = "unchanged"/expect = "ok"         /' signet.dev.toml
grep -n '^expect' signet.dev.toml; echo
echo '# edit validate_handle: at most 16 characters'
perl -0pi -e 's/(fn validate_handle\(handle: &String\) -> Result<\(\), Error> \{\n    let len = handle.len\(\);\n    if len == 0 \|\| len > )MAX_HANDLE_LEN/${1}16/' packages/contracts/identity-registry/src/lib.rs
grep -n 'len > 16' packages/contracts/identity-registry/src/lib.rs; echo
run signet dev --ci
run signet sandbox export -o .signet/regression.json
run signet dev --ci --bundle .signet/regression.json --junit junit.xml
date -u +"session ended %Y-%m-%dT%H:%M:%SZ"
