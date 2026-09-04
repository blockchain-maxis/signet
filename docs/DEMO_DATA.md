# Demo data — provenance, schema, and honesty policy

Signet ships three curated demo profiles so the `/p/{handle}` UI can be
reviewed without a database, an indexer, or a funded wallet. Those profiles
are **synthetic testnet fixtures**. This document is the single source of
truth for where they came from, how to regenerate them, and the rules that
keep them from being mistaken for real activity.

Related work: [#46](https://github.com/blockchain-maxis/signet/issues/46)
(suppress explorer links), [#56](https://github.com/blockchain-maxis/signet/issues/56)
(seed real testnet ops), [#57](https://github.com/blockchain-maxis/signet/issues/57)
(single address source), [#58](https://github.com/blockchain-maxis/signet/issues/58)
(CI guard for dead wallets).

---

## Honesty policy

Synthetic demo data is a product surface, not a shortcut. Every contributor
and every render path must follow these rules:

1. **Always labelled.** Every surface that renders fixture data must mark it
   as synthetic / testnet demo — badge, copy, footer, and marketing cards.
   Current labels live in:
   - `apps/web/app/p/[handle]/page.tsx` (`Synthetic data · Testnet demo`)
   - `apps/web/app/(marketing)/sections/demos.tsx`
   - `apps/web/app/how-it-works/page.tsx`
   - `README.md` live-demo table
2. **Never presented as a real account.** Fixtures must not be described as
   mainnet activity, as belonging to a real person, or as proof of a career.
3. **Never linked to a block explorer as if real.** Wallet addresses and
   transaction hashes from fixtures must not open Stellar Expert (or any
   explorer) in a way that implies the account or tx exists on-chain. Until
   a handle graduates (see below), explorer links are suppressed or clearly
   disabled. See [#46](https://github.com/blockchain-maxis/signet/issues/46).
4. **Separate from chain-bound profiles.** Once a handle is bound on-chain and
   backed by indexer/Horizon data, it leaves the fixture set. The UI then
   renders real activity without the synthetic badge.

Breaking rule 1 or 3 is a release blocker.

---

## Generating accounts

The three Phase-1 demo personas use **synthetic Stellar testnet-shaped
addresses**. They were generated as demo key material for the UI — they are
not claimed by a real person, are not the project's admin keys, and (until
[#56](https://github.com/blockchain-maxis/signet/issues/56) lands) are not
guaranteed to resolve on `horizon-testnet.stellar.org`.

| Handle | Display name | Wallet (G…) | Fixture theme |
|--------|--------------|-------------|---------------|
| `aquawolf` | Aqua Wolf | `GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD` | Blend-style collateral ops |
| `sorobuilder` | Soro Builder | `GBVBJEP2BSKHW6YBFCZR2HJKHZDLJOU7ZKTH2HSNUUQY322RWLURH3EQ` | Soroswap-style DEX swaps |
| `stellardev` | Stellar Dev | `GBNOH2NKPHZYOWF2LHLSZ27R54NMCH66KPBEEY6MCE4FM5V6PNZVHZKL` | USDC token transfers |

Addresses live in exactly one place: `DEMO_PROFILES` in
`packages/types/src/index.ts`. Both consumers derive from it —
`apps/web/lib/profiles.ts` (the static profile layer) and
`apps/indexer/src/seed-data.ts` (the indexer seed) — so they cannot drift.
Edit a persona there and both follow.

Operation rows in `apps/web/public/data/{handle}.json` are **Horizon-shaped
fixture records** (ids, timestamps, decoded function names, balance changes)
written so the profile UI has something honest to render. Transaction hashes
inside those files are part of the fixture payload; they must not be treated
as proof of chain inclusion while the profile is still synthetic.

---

## Nightly guard: what a red run means

`scripts/check-demo-wallets.mjs` (workflow: **Demo Data Check**, scheduled
nightly and on demand) exists so that demo-data drift is caught by the
pipeline rather than by a contributor. It is deliberately split into two
tiers, so a red run always means *something changed*:

**Enforced — a failure fails the workflow.** These are invariants this
repository controls, and the ones that break when personas are edited or
refactored:

- every persona in `DEMO_PROFILES` has a well-formed Stellar account address
  (`G` + 55 base32 characters);
- no two personas share an address;
- every persona has an activity fixture at `apps/web/public/data/{handle}.json`
  whose records all carry that persona's address as `source_account` — the
  reviewer checklist item at the bottom of this page, enforced.

**Advisory — reported, but does not fail the workflow.** Whether each wallet
resolves on Horizon. The Phase-1 personas are synthetic and have never been
funded, so `GET /accounts/{wallet}` 404s for all three. That is the known,
unfixed state tracked by
[#56](https://github.com/blockchain-maxis/signet/issues/56), not a change — so
the run reports it (job summary and a workflow notice) instead of going red on
it every night. A guard that is red on every run is a guard everyone learns to
ignore.

Once #56 lands and the personas are backed by real, funded accounts, set the
repository variable `DEMO_WALLETS_REQUIRE_HORIZON` to `1`. Horizon resolution
then becomes enforced, and a persona whose account stops resolving fails the
workflow again. The run tells you when to do this: with every wallet
resolving, it prints a notice saying so. `DEMO_HORIZON_URL` overrides the
Horizon base if the personas are ever backed on another network.

Run it locally with:

```bash
node --experimental-strip-types scripts/check-demo-wallets.mjs
```

---

## File layout

```
packages/types/src/
  index.ts            # DEMO_PROFILES — handle, name, wallet, bio, joined

apps/web/public/data/
  aquawolf.json       # Horizon-shaped operations for aquawolf
  sorobuilder.json
  stellardev.json
```

`apps/web/lib/profiles.ts` builds its profile manifest from `DEMO_PROFILES` and
reads the operation fixtures from `public/data/`. With no `DATABASE_URL` (or an
empty DB) and no deployed registry, `/p/{handle}` is entirely fixture-driven.

---

## Schemas

### `DEMO_PROFILES` (`packages/types/src/index.ts`)

```ts
{
  handle: string;  // [a-z0-9_-]{1,32} — same charset as the on-chain registry
  name: string;    // display name
  wallet: string;  // G… Stellar public key
  bio: string;     // must identify the persona as demo
  joined: string;  // ISO date YYYY-MM-DD
}
```

- `bio` should include the words "Demo persona" (or equivalent) so anyone
  reading the source still sees the honesty signal.

### `{handle}.json` (operations fixture)

Mirrors a Horizon operations collection page:

```json
{
  "_embedded": {
    "records": [
      {
        "id": "string — synthetic operation id",
        "type": "invoke_host_function",
        "function": "HostFunctionTypeHostFunctionTypeInvokeContract",
        "decoded_function": "string — human-readable contract fn",
        "source_account": "string — must equal the persona's DEMO_PROFILES wallet",
        "created_at": "string — ISO-8601 timestamp",
        "transaction_hash": "string — 64-char hex",
        "transaction_successful": true,
        "asset_balance_changes": [
          {
            "asset_type": "native | credit_alphanum4 | credit_alphanum12",
            "asset_code": "string — optional, e.g. USDC",
            "type": "transfer",
            "from": "string — G… or C…",
            "to": "string — G… or C…",
            "amount": "string — decimal"
          }
        ]
      }
    ]
  }
}
```

Required per record: `id`, `type`, `created_at`, `source_account`,
`transaction_successful`. Prefer newest-first order (matches Horizon
`order=desc`).

The TypeScript shape consumed by the UI is `Operation` in
`apps/web/lib/profiles.ts`.

---

## Regenerate or add a fixture

### Update an existing handle (manual, current path)

1. Edit `apps/web/public/data/{handle}.json`. Keep the Horizon envelope
   (`_embedded.records`). Keep `source_account` equal to the persona's wallet
   in `DEMO_PROFILES`.
2. If the wallet or bio changes, edit `DEMO_PROFILES` in
   `packages/types/src/index.ts` — the web app and the indexer seed both
   derive from it, so there is nothing else to keep in step.
3. Confirm every UI surface still shows the synthetic badge
   (`pnpm --filter @signet/web dev`, open `/p/{handle}`).
4. Do **not** add explorer links for fixture wallets or tx hashes.

### Add a new demo handle

1. Choose a free handle matching `[a-z0-9_-]{1,32}`.
2. Add an entry to `DEMO_PROFILES` (`packages/types/src/index.ts`) with a demo
   bio and a synthetic `G…` wallet (generate with
   `stellar keys generate <alias> --network testnet` or any ed25519 tool —
   **do not** reuse a real person's address).
3. Create `apps/web/public/data/{handle}.json` with at least one
   Horizon-shaped record whose `source_account` matches the wallet.
4. Smoke-check `/p/{handle}` and the landing demos section if you add a card.

### Preferred future path (issue #56)

When `scripts/seed-testnet-demo.ts` exists:

1. Generate keypairs, fund via Friendbot, submit real testnet operations
   (including an optional registry `claim`).
2. Dump each account's real Horizon operations into
   `public/data/{handle}.json`.
3. Update `DEMO_PROFILES` with the funded public keys.
4. At that point explorer links become valid **only if** the UI still labels
   the profiles as demo personas (synthetic identity, real testnet ops) —
   or the handle graduates (next section).

---

## Graduation: fixture → chain-bound

A handle **graduates** out of the fixture set when all of the following are
true:

1. The handle is bound on-chain in the Identity Registry
   (`claim(handle, wallet)` succeeded; `resolve(handle)` returns the wallet).
2. The indexer (or live Horizon path) supplies operations for that wallet
   into the DB / read path used by `getProfile` / `getOperations`.
3. The static manifest no longer needs to invent activity for that handle.

**What to do on graduation:**

1. Remove the handle from `DEMO_PROFILES` (and delete
   `apps/web/public/data/{handle}.json` if it only held fixtures). The indexer
   seed follows automatically.
2. Drop the synthetic badge for that profile — chain-bound renders use real
   activity and may link to explorers.
3. Leave handles that are still curated demos in the fixture set with full
   labelling.

Until graduation, curated handles stay fixtures even if a coincidentally
similar address appears on testnet.

---

## Quick checklist for PR reviewers

- [ ] Synthetic badge visible on `/p/{handle}` for every fixture handle
- [ ] No explorer link treats a fixture wallet/tx as a live account
- [ ] `DEMO_PROFILES` wallet === each record's `source_account`
- [ ] Bios still say the persona is a demo
