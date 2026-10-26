# Tutorial: fork the Signet registry and catch a breaking change

A walk through the sandbox on a contract every contributor already has:
Signet's own registry on testnet, `CASF…RCN`. Every output block
below is from a real run, on 2026-10-26, with the fork ledger
shown; yours will differ in ledger numbers, ages and the transactions the
registry has seen since. The whole session is in
[`sandbox/testdata/tutorial/session.log`](../sandbox/testdata/tutorial/session.log),
and [`run.sh`](../sandbox/testdata/tutorial/run.sh) beside it replays it.

You need `signet` with `signet-simulator` ([Install](SANDBOX.md#install)), the
`stellar` CLI 25.2.0 or newer, Rust with the `wasm32v1-none` target, a clone
of this repository, and network access to testnet's RPC. Run everything from
the repository's root.

```bash
REGISTRY=CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
WALLET=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
OTHER=GC6YINA5FD5MLUI4LKC4JYI5AKAW7BRFJRKNEU3TVRZWYNYN3KKZJR3G
```

## 1. Fork it

```bash
signet sandbox fork $REGISTRY
```

```text
Forked CASF…RCN on testnet at ledger 5397441 (protocol 29, 15s ago) · wasm 9369…fe · instance storage 2 entries
```

The fork pins testnet's latest ledger and caches the registry's instance, its
WASM and the network config. Nothing else is fetched until a call reads it.

## 2. Call it

```bash
signet sandbox call $REGISTRY count
signet sandbox call $REGISTRY resolve --arg handle=alice
```

```text
→ 3
⚠ auth mocked: signatures were not checked
ran against testnet · fork ledger 5397441 (16s ago) · protocol 29 lane · no drift · auth mocked
→ (nothing)
⚠ auth mocked: signatures were not checked
ran against testnet · fork ledger 5397441 (18s ago) · protocol 29 lane · no drift · auth mocked
```

Three handles are bound, and `alice` is not one of them. Each call ran
locally, against the fork's ledger, and says so.

## 3. Make a handle taken, and claim it

A claim of `alice` would succeed:

```bash
signet sandbox call $REGISTRY claim --arg handle=alice --arg wallet=$WALLET
```

```text
Would write 4 entries · requires auth from GA5Z…ZVN (claim)
Local sandbox: nothing was submitted to testnet
⚠ auth mocked: signatures were not checked
ran against testnet · fork ledger 5397441 (21s ago) · protocol 29 lane · no drift · auth mocked
```

An override writes `Owner("alice")` for this call only, as if someone else
held the handle, and the same claim now fails with the contract's own error:

```bash
signet sandbox call $REGISTRY claim --arg handle=alice --arg wallet=$WALLET \
  --set-storage "persistent:Owner(\"alice\")=\"$OTHER\""
```

```text
✗ HandleTaken (#3)
ran against testnet · fork ledger 5397441 (24s ago) · protocol 29 lane · no drift · 1 override · auth mocked
```

## 4. Develop against it

`signet dev init` writes a `signet.dev.toml` with a saved call for each
function that takes no arguments and writes nothing, here `count`:

```bash
signet dev init $REGISTRY --path packages/contracts/identity-registry
signet dev
```

```text
Wrote <the repository>/signet.dev.toml with 1 saved call: count
```

`signet dev` builds the crate, forks the registry, and replays the saved call
and the registry's latest real transactions on the deployed code (A) and the
build (B), from the same state; then it watches the source and does it again
on every save. Its first cycle (shown here from `signet dev --ci`, which runs
one cycle and exits):

```text
signet dev · CASF…RCN @ testnet ledger 5397447 · lane p29 · crate identity-registry
12 real transactions to replay (ledgers 5276490–5397449): found 12 by events
✗ build 3.0s · install 9ms · swap 27ms · 1 saved + 12 real replays 7.5s · 1 expectation failed · 0 breaking · 6 cost · 0 ignored · 6 low-fidelity
  interface: 0 breaking, 7 compatible, 3 info
  expected
    count                               ✗ expected unchanged: A and B differ: 0 breaking, 0 behavioural, 3 cost  resources: instructions +11.3% (371,738 → 413,603), mem_bytes +0.5% (1,211,208 → 1,217,492), resource_fee +1579% (5,191 → 87,155)
  cost
    tx d465… (ledger 5279621, claim)    resources: instructions +5.8% (607,584 → 642,997), mem_bytes +0.5% (1,220,616 → 1,227,036), resource_fee +189% (43,370 → 125,331)
    tx af14… (ledger 5279615, claim)    resources: instructions +5.8% (607,584 → 642,997), mem_bytes +0.5% (1,220,616 → 1,227,036), resource_fee +189% (43,370 → 125,331)
    tx eb61… (ledger 5279615, claim)    resources: instructions +5.8% (607,584 → 642,997), mem_bytes +0.5% (1,220,616 → 1,227,036), resource_fee +189% (43,370 → 125,331)
    tx 5650… (ledger 5279575, claim)    resources: instructions +5.8% (607,584 → 642,997), mem_bytes +0.5% (1,220,616 → 1,227,036), resource_fee +189% (43,370 → 125,331)
    tx 7963… (ledger 5279567, claim)    resources: instructions +5.8% (607,584 → 642,997), mem_bytes +0.5% (1,220,616 → 1,227,036), resource_fee +189% (43,370 → 125,331)
    tx f535… (ledger 5279565, claim)    resources: instructions +5.8% (607,584 → 642,997), mem_bytes +0.5% (1,220,616 → 1,227,036), resource_fee +189% (43,370 → 125,331)
  low-fidelity (not counted)
    tx 82c8… (ledger 5279622, release)  · low-fidelity (state changed since ledger 5279622): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 6ba9… (ledger 5279616, release)  · low-fidelity (state changed since ledger 5279616): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 7e92… (ledger 5279616, release)  · low-fidelity (state changed since ledger 5279616): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 975a… (ledger 5279576, release)  · low-fidelity (state changed since ledger 5279576): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 1353… (ledger 5279570, release)  · low-fidelity (state changed since ledger 5279570): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 786a… (ledger 5279566, release)  · low-fidelity (state changed since ledger 5279566): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
1 item failed the checks (--fail-on)
```

Three things to read in it:

- Nothing broke: the build is the registry's own source. But a build from
  source is rarely byte-identical to the deployed WASM, so every call costs a
  little more or less, and `count`'s `expect = "unchanged"` counts cost. Set
  it to `expect = "ok"` in `signet.dev.toml` (or allow for it with
  `[diff] resource_tolerance`). The resource fee on B is higher than the
  instructions explain, a known simulator issue with freshly installed code;
  treat B's fees as an upper bound for now.
- The 12 real transactions are recent claims and releases. The claims replay
  as they ran on-chain.
- The releases are **low-fidelity**: each released a handle that is free
  again today, so the deployed code fails them now where they succeeded
  on-chain. Their A/B diffs say nothing about your change, and they are not
  counted.

## 5. Make a breaking change

Tighten `validate_handle` in
`packages/contracts/identity-registry/src/lib.rs` to reject handles over 16
characters, though the deployed contract allows 32:

```rust
    if len == 0 || len > 16 {
```

On save, the next cycle flags every real claim that would now fail:

```text
signet dev · CASF…RCN @ testnet ledger 5397455 · lane p29 · crate identity-registry
12 real transactions to replay (ledgers 5276498–5397457): found 12 by events
✗ build 2.3s · install 7ms · swap 24ms · 1 saved + 12 real replays 9.7s · 6 breaking · 1 cost · 0 ignored · 6 low-fidelity
  interface: 0 breaking, 7 compatible, 3 info
  breaking
    tx d465… (ledger 5279621, claim)    return: Ok(()) → Err(InvalidHandle)
    tx af14… (ledger 5279615, claim)    return: Ok(()) → Err(InvalidHandle)
    tx eb61… (ledger 5279615, claim)    return: Ok(()) → Err(InvalidHandle)
    tx 5650… (ledger 5279575, claim)    return: Ok(()) → Err(InvalidHandle)
    tx 7963… (ledger 5279567, claim)    return: Ok(()) → Err(InvalidHandle)
    tx f535… (ledger 5279565, claim)    return: Ok(()) → Err(InvalidHandle)
  cost
    count                               resources: instructions +11.3% (371,738 → 413,603), mem_bytes +0.5% (1,211,208 → 1,217,492), resource_fee +1579% (5,191 → 87,157)
  low-fidelity (not counted)
    tx 82c8… (ledger 5279622, release)  · low-fidelity (state changed since ledger 5279622): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 6ba9… (ledger 5279616, release)  · low-fidelity (state changed since ledger 5279616): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 7e92… (ledger 5279616, release)  · low-fidelity (state changed since ledger 5279616): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 975a… (ledger 5279576, release)  · low-fidelity (state changed since ledger 5279576): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 1353… (ledger 5279570, release)  · low-fidelity (state changed since ledger 5279570): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
    tx 786a… (ledger 5279566, release)  · low-fidelity (state changed since ledger 5279566): the deployed code fails here now (Error(Contract, #4)), where it succeeded on-chain
6 items failed the checks (--fail-on)
```

The registry's e2e handles are 17 characters long, so every recent claim
would now return `InvalidHandle`. A change that looked harmless breaks real
traffic, and the replay names each transaction.

## 6. Only a "what if"

The registry is not upgradeable (#540): it has no `upgrade` function, so this
build could never replace the deployed code. The sandbox swaps the build into
a local copy of the instance, which is how it compares the two for any
contract; for this one, the result is a "what if".

## 7. Keep it as a CI check

Export the session as a repro bundle, and the same check runs offline, with
no RPC and the same result every time:

```bash
signet sandbox export -o .signet/regression.json
signet dev --ci --bundle .signet/regression.json --junit junit.xml
```

```text
Note: fork data is public chain state, but the overrides and saved-call arguments in the bundle are whatever was typed. Read it before sharing.
Wrote .signet/regression.json (45755 bytes): 2 entries, 13 calls, bundleHash 906fbe855ad99ab16dc81a5f049a99c35766f70225ef9dcf68bcdf9f708ca6ce
✗ build 762ms · install 7ms · swap 22ms · 1 saved + 12 real replays 495ms · 6 breaking · 1 cost · 0 ignored
  interface: 0 breaking, 7 compatible, 3 info
  breaking
    tx d465… (ledger 5279621, claim)    return: Ok(()) → Err(InvalidHandle)
    tx af14… (ledger 5279615, claim)    return: Ok(()) → Err(InvalidHandle)
    tx eb61… (ledger 5279615, claim)    return: Ok(()) → Err(InvalidHandle)
    tx 5650… (ledger 5279575, claim)    return: Ok(()) → Err(InvalidHandle)
    tx 7963… (ledger 5279567, claim)    return: Ok(()) → Err(InvalidHandle)
    tx f535… (ledger 5279565, claim)    return: Ok(()) → Err(InvalidHandle)
  cost
    count                               resources: instructions +11.3% (371,738 → 413,603), mem_bytes +0.5% (1,211,208 → 1,217,492), resource_fee +1579% (5,191 → 87,157)
6 items failed the checks (--fail-on)
session ended 2026-10-26T10:34:55Z
```

It exits 10, and `junit.xml` has a failing testcase for each claim.
[`docs/examples/signet-dev-ci.yml`](examples/signet-dev-ci.yml) runs exactly
this command in a contract's own CI ([`signet dev --ci`](SANDBOX.md#signet-dev---ci)).
