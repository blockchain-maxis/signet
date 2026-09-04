# Integrating with the Signet Identity Registry

The Identity Registry is a Soroban contract that binds a Stellar wallet to a Signet handle
on-chain. Anyone can read it — resolving `aquawolf → G…` needs no Signet API, no database
and no permission, just a Soroban RPC endpoint.

This document is the integration reference: deployment coordinates, every error code, the
exact shape of every event, and copy-pasteable `@stellar/stellar-sdk` snippets for reading
and for claiming. For the contract's own source see
[`packages/contracts/identity-registry`](../packages/contracts/identity-registry).

---

## 1. Deployment

| | |
|--|--|
| **Network** | Stellar **testnet** |
| **Network passphrase** | `Test SDF Network ; September 2015` |
| **Contract id** | `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN` |
| **Wasm sha256** | `936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe` |
| **Soroban RPC** | `https://soroban-testnet.stellar.org` |
| **Deployed** | 2026-07-09 |
| **Status** | Deployed and initialized. No mainnet deployment yet. |

> **Pin the id, but expect it to change.** The contract is immutable, so a defect
> in it is fixed by deploying a *new* contract id and migrating bindings to it —
> there is no in-place upgrade that would keep this id valid. Reading a
> superseded registry fails silently: `resolve` returns the old answer, or
> `null`, with no error to catch. Treat the contract id as configuration, not a
> constant, and watch this section. The migration procedure, including what
> integrators are told and when, is
> [`CONTRACT_MIGRATION.md`](CONTRACT_MIGRATION.md).

```bash
npm install @stellar/stellar-sdk    # v15.x — the version this repo pins
```

The wasm hash is pinned deliberately. `main` moves faster than the deployment, so the
contract source in this repo can be ahead of what is actually on-chain — §2 says exactly
which methods the pinned wasm exposes. Verify for yourself at any time:

```bash
stellar contract info interface --network testnet \
  --id CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
```

---

## 2. Interface

### Callable on the deployment above

These are the methods the pinned wasm exposes. Everything in §3–§6 targets this set.

| Method | Auth | Returns | Notes |
|--------|------|---------|-------|
| `initialize(admin: Address)` | — | `()` | One-time. Already called on the deployment above. |
| `claim(handle: String, wallet: Address)` | `wallet` | `()` | Binds `handle ↔ wallet`. Emits `claimed`. |
| `release(handle: String)` | owning wallet | `()` | Emits `released`. |
| `admin_revoke(handle: String)` | admin | `()` | Moderation. Emits `revoked`. |
| `resolve(handle: String)` | — | `Option<Address>` | Handle → wallet. |
| `lookup(wallet: Address)` | — | `Option<String>` | Wallet → handle. |
| `is_bound(handle: String)` | — | `bool` | |
| `count()` | — | `u32` | Binding counter, O(1). An upper bound: a binding that archives unaccessed is never subtracted. |

### In `main`, not yet deployed

Implemented and unit-tested in
[`packages/contracts/identity-registry`](../packages/contracts/identity-registry), but **not
present in the pinned wasm** — invoking them against the contract id above fails. They become
callable at the next deployment, which will mint a new contract id.

| Method | Auth | Returns | Notes |
|--------|------|---------|-------|
| `transfer_handle(handle: String, new_wallet: Address)` | current owner | `()` | Emits `transferred`. |
| `resolve_batch(handles: Vec<String>)` | — | `Vec<Option<Address>>` | Positional; max 100 per call. |
| `set_admin(new_admin: Address)` | current admin | `()` | Rotates moderation authority. Emits `admin_changed`. |

Bindings are **1:1** — one handle per wallet, one wallet per handle. Handles are 1–32
bytes of `[a-z0-9_-]`. There is no on-chain enumeration; see §5.

---

## 3. Errors

The contract's `Error` enum is `#[contracterror] #[repr(u32)]`, so Soroban surfaces the
discriminant as a numeric contract error. In a failed simulation it appears as
`HostError: Error(Contract, #N)`; in a submitted transaction's result it appears as a
`contractError` value in the XDR.

| # | Variant | Raised when |
|---|---------|-------------|
| 1 | `AlreadyInitialized` | `initialize` called on a registry that already has an admin. |
| 2 | `NotInitialized` | Any of `claim`, `release`, `transfer_handle`, `admin_revoke` before `initialize`. |
| 3 | `HandleTaken` | `claim` for a handle that is already bound. |
| 4 | `HandleNotFound` | `release` / `transfer_handle` / `admin_revoke` for an unbound handle. |
| 5 | `NotOwner` | Reserved for ownership violations. Note that `release` and `transfer_handle` enforce ownership through `require_auth` on the resolved owner, so a non-owner fails with an **auth** error, not this code. |
| 6 | `InvalidHandle` | `claim` with an empty handle, one longer than 32 bytes, or one containing anything outside `[a-z0-9_-]` (including uppercase). |
| 7 | `WalletAlreadyBound` | `claim` (or `transfer_handle` to a target) for a wallet that already owns a handle. |
| 8 † | `HandleReserved` | `claim` for a name that collides with a Signet app route (`p`, `api`, `app`, `admin`, `docs`, `handles`, `how-it-works`, `profile`, `robots`, `sitemap`). |
| 9 † | `BatchTooLarge` | `resolve_batch` with more than 100 handles. |

† Codes 8 and 9 are **not** in the deployed wasm — like `transfer_handle` and
`resolve_batch`, they arrived after the 2026-07-09 deployment. Two consequences for anyone
integrating against the pinned contract id today: the reserved-name check is not enforced
on-chain, so a direct caller can bind e.g. `app` (the web app's own router refuses to route
reserved names to a profile, so this shadows nothing there); and `resolve_batch` is absent
entirely. Both take effect at the next deployment.

Anything raised by `require_auth` — a missing or invalid signature — is a Soroban **auth**
error, not one of the above.

The web app already maps these to user-facing strings in
[`apps/web/lib/contract-errors.ts`](../apps/web/lib/contract-errors.ts); reuse that mapping
rather than re-deriving it.

---

## 4. Events

Every state change publishes one event. The topic tuple is always
`(Symbol(kind), String(handle))`; only the data payload varies.

| Kind | Topics | Data | Emitted by |
|------|--------|------|------------|
| `claimed` | `[ symbol("claimed"), string(handle) ]` | `address(wallet)` | `claim` |
| `released` | `[ symbol("released"), string(handle) ]` | `address(wallet)` | `release` |
| `revoked` | `[ symbol("revoked"), string(handle) ]` | `address(wallet)` | `admin_revoke` |
| `transferred` † | `[ symbol("transferred"), string(handle) ]` | `[ address(from), address(to) ]` (a 2-tuple) | `transfer_handle` |

† `transfer_handle` is not in the deployed wasm (see §2), so the pinned deployment never
emits `transferred`. It is documented here so consumers written now keep working after the
next deployment.

Decoding one event:

```ts
import { scValToNative, xdr } from '@stellar/stellar-sdk';

function decode(topics: xdr.ScVal[], value: xdr.ScVal) {
  if (topics.length < 2) return null;
  const kind = scValToNative(topics[0]!) as string;   // 'claimed' | 'released' | 'revoked' | 'transferred'
  const handle = String(scValToNative(topics[1]!));   // 'aquawolf'
  const data = scValToNative(value);                  // 'G…'  — or ['G…from', 'G…to'] for transferred
  return { kind, handle, data };
}
```

> **`transferred` carries a different payload shape.** Both existing consumers
> ([the indexer](../apps/indexer/src/workers/attestation.ts) and
> [the `/handles` directory](../apps/web/lib/directory.ts)) only handle `claimed` /
> `released` (/ `revoked`), so a transfer is currently ignored by both and their view of
> the binding goes stale. Handle it explicitly in your own consumer: treat it as a
> `released(from)` followed by a `claimed(to)`.

---

## 5. Reading the registry

### Read-only calls (simulation — free, no signature, no submission)

Read methods are invoked by *simulating* a transaction and taking the return value. No
account is funded or debited, and nothing is submitted; the source account only has to
exist.

```ts
import {
  Account, Address, BASE_FEE, Contract, TransactionBuilder,
  nativeToScVal, scValToNative, rpc,
} from '@stellar/stellar-sdk';

const CONTRACT_ID = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

const server = new rpc.Server('https://soroban-testnet.stellar.org');
const contract = new Contract(CONTRACT_ID);

/** Simulate a read-only call and return its native value. */
async function read(method: string, ...args: xdr.ScVal[]) {
  // Any existing account works as the simulation source; sequence number is ignored.
  const source = new Account('GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD', '0');
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error); // e.g. 'HostError: Error(Contract, #6)'
  return scValToNative(sim.result!.retval);
}

const handleArg = (h: string) => nativeToScVal(h, { type: 'string' });

await read('count');                                   // 0
await read('is_bound', handleArg('aquawolf'));         // false
await read('resolve',  handleArg('aquawolf'));         // null  → 'G…' once bound
await read('lookup',   new Address('G…').toScVal());   // null  → 'aquawolf' once bound
```

`resolve` and `lookup` return Soroban `Option`s, which `scValToNative` turns into `null`
when empty — so `null` means "not bound", and there is no error to catch for a miss.

> `resolve` and `lookup` extend the storage TTL of an entry they find. That write is
> discarded in simulation, so read-only use never costs anything, but it does mean an
> *invoked* (submitted) read keeps active handles alive.

### Enumerating handles from the event stream

`count()` is O(1) by design; the contract deliberately stores no list. To get the full set,
replay `claimed` / `released` (/ `revoked`) and fold them:

```ts
const { sequence } = await server.getLatestLedger();

// Public RPC's advertised retention (~24h) overstates what getEvents actually
// serves: it returns a valid empty result — not an error — once startLedger is
// more than ~10,700 ledgers (~15h) behind the tip. Stay well under that; there
// is nothing to catch if you go past it, so verify empirically before raising it.
let startLedger = Math.max(1, sequence - 8_000);
let cursor: string | undefined;
const bound = new Map<string, string>();   // handle → wallet

for (let page = 0; page < 50; page++) {
  const res = await server.getEvents({
    ...(cursor ? { cursor } : { startLedger }),
    filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
    limit: 200,
  });

  for (const e of res.events) {
    const kind = scValToNative(e.topic[0]!) as string;
    const handle = String(scValToNative(e.topic[1]!));
    if (kind === 'claimed') bound.set(handle, String(scValToNative(e.value)));
    else if (kind === 'released' || kind === 'revoked') bound.delete(handle);
    else if (kind === 'transferred') bound.set(handle, scValToNative(e.value)[1]); // [from, to]
  }

  if (res.events.length < 200) break;       // caught up
  cursor = res.cursor;
  if (!cursor) break;
}

console.log([...bound.entries()]);          // [] against the current testnet deployment
```

Three properties to respect:

- **Order matters.** Events arrive oldest → newest; the last event for a handle wins. Fold
  them in order, don't dedupe by handle first.
- **Paginate.** One call returns at most 200 events. Take `res.cursor` and pass it *instead
  of* `startLedger` on the next call; stop when a page is short.
- **The window is bounded.** Public RPC keeps roughly the last 24 h, so a from-scratch
  replay can only rebuild handles claimed inside that window. For a complete history you
  need an archival RPC node, or a persistent cursor that has been running since deployment
  — which is exactly what
  [the indexer's attestation worker](../apps/indexer/src/workers/attestation.ts) is for.

For a working implementation of this fold, see
[`apps/web/lib/directory.ts`](../apps/web/lib/directory.ts) (`reduceBindings`).

---

## 6. Claiming a handle

`claim` is a state change: it must be built, simulated (to attach the Soroban resource
footprint and auth entries), signed by the **claiming wallet**, then submitted. The
signature *is* the proof of ownership — `wallet.require_auth()` is what makes the registry
self-sovereign.

```ts
import {
  Address, BASE_FEE, Contract, Keypair, TransactionBuilder,
  nativeToScVal, rpc,
} from '@stellar/stellar-sdk';

const server = new rpc.Server('https://soroban-testnet.stellar.org');
const contract = new Contract('CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN');
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

const keypair = Keypair.fromSecret(process.env.SECRET!);   // must be the claiming wallet
const wallet = keypair.publicKey();

// 1. Build.
const account = await server.getAccount(wallet);
const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
  .addOperation(
    contract.call(
      'claim',
      nativeToScVal('aquawolf', { type: 'string' }),
      new Address(wallet).toScVal(),
    ),
  )
  .setTimeout(60)
  .build();

// 2. Simulate + assemble. Contract errors surface here, before you spend anything.
const prepared = await server.prepareTransaction(tx);

// 3. Sign — this is the ownership proof.
prepared.sign(keypair);

// 4. Submit, then poll to completion (sendTransaction only queues it).
const sent = await server.sendTransaction(prepared);
if (sent.status === 'ERROR') throw new Error(JSON.stringify(sent.errorResult));

let result = await server.getTransaction(sent.hash);
while (result.status === 'NOT_FOUND') {
  await new Promise((r) => setTimeout(r, 1000));
  result = await server.getTransaction(sent.hash);
}
if (result.status !== 'SUCCESS') throw new Error(`claim failed: ${result.status}`);
console.log('claimed, tx', sent.hash);
```

Notes:

- **Step 2 is where errors show up.** A rejected claim fails in simulation with
  `HostError: Error(Contract, #N)` — map `N` via §3. Verified against the live deployment:
  `claim('NOT valid!', …)` fails with `Error(Contract, #6)` (`InvalidHandle`).
- **Fees.** `prepareTransaction` replaces `BASE_FEE` with the simulated resource fee — a
  claim against the current deployment assembles at roughly 6.16 million stroops (~0.62
  XLM) on testnet, and the exact figure moves between simulations. Never hard-code it.
- **Browser wallets.** Replace step 3 with your wallet adapter: pass `prepared.toXDR()` to
  the wallet, get signed XDR back, and rebuild with
  `TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)`. See
  [`apps/web/lib/registry.ts`](../apps/web/lib/registry.ts).
- **Funding.** The claiming account must exist and hold XLM. On testnet:
  `curl "https://friendbot.stellar.org/?addr=<G…>"`.
- `release(handle)` follows the identical build → simulate → sign → submit shape, and
  requires auth from the **current owner**, which the contract resolves from the handle
  rather than from the transaction source. `transfer_handle(handle, new_wallet)` works the
  same way but is not in the deployed wasm yet (§2).

---

## 7. Deploying your own registry

Point your integration at a different instance by rebuilding and deploying the contract —
see [`packages/contracts/identity-registry/README.md`](../packages/contracts/identity-registry/README.md)
and [`infra/deploy-contract.sh`](../infra/deploy-contract.sh), plus the deploy notes at the
bottom of [`.env.example`](../.env.example) (including the `--network testnet` passphrase
workaround for stellar CLI 25.2.0). Remember to call `initialize(admin)` afterwards — every
state-changing method returns `NotInitialized` (#2) until you do.
