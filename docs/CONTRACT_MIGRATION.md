# Identity Registry migration runbook

The Identity Registry is **immutable**. There is no upgrade entrypoint, no proxy,
no admin write to storage — the deployed wasm is the wasm, forever
([`packages/contracts/identity-registry/src/lib.rs`](../packages/contracts/identity-registry/src/lib.rs)).
That is a deliberate trade: nobody, including the maintainers, can rewrite the
rule that a binding requires the wallet's own signature.

The consequence is that a bug found after deployment cannot be patched in place.
Recovery means deploying a *new* contract and moving every binding to it. This
document is how that is done, written before it is needed, because working it out
under incident conditions is how bindings get lost.

**Read [§1](#1-decisions-recorded-in-advance) before you need any of the rest.**
Two of its consequences have to be acted on *now*, not during an incident.

---

## 1. Decisions recorded in advance

| Decision | Consequence |
| --- | --- |
| The contract is immutable and stays immutable. | A bug is fixed by deploying a new contract id, never by patching. Every reader pinned to the old id keeps reading the old, buggy state until it is repointed. |
| **Bindings are not transferred by an admin. Users re-claim.** | `claim` calls `wallet.require_auth()`, so only the key holder can create a binding — that is the whole trust model, and a migration is not a reason to break it. Every user signs one transaction on the new registry. Nobody's handle moves without them. |
| The replacement contract *reserves* handles for their prior owners during a grace period. | The admin can say "this handle may only be claimed by that wallet"; it cannot say "this handle now belongs to that wallet". This is what keeps re-claiming from becoming a land grab, without introducing an oracle. It requires code that is **not in the current wasm** — see [§4](#4-the-replacement-contract). |
| The binding set is reconstructed from a **snapshot we keep continuously**, not from a replay run after the incident. | Soroban RPC serves only a short event window (see [§2](#2-the-precondition-you-have-to-satisfy-today)). A migration planned around "replay the event stream when the time comes" would find the stream already gone. |

If a future maintainer decides against the reservation step, the fallback is
plain first-come re-claiming, and the honest statement of that is already in the
product: the docs page says a replacement registry means re-claiming, so nobody
claims a handle today believing it is permanent under a contract that is replaced.

---

## 2. The precondition you have to satisfy today

**Soroban RPC is not an archive.** `getEvents` on the public testnet endpoint
returns an empty — not failing — result once `startLedger` is roughly 10,700
ledgers (~15h) behind the tip; the app's own scan window is capped at 8,000
ledgers for that reason (see the note on `REGISTRY_EVENT_WINDOW_LEDGERS` in
[`apps/web/lib/directory.ts`](../apps/web/lib/directory.ts)). Anything claimed
before that window is invisible to a replay started today.

There is also no on-chain enumeration: the contract keeps an O(1) `count()`, and
the handle *list* only ever existed off-chain. So the binding set has exactly
three durable sources, and you need at least one of them intact:

| Source | Covers | Caveat |
| --- | --- | --- |
| **Indexer database** — `Profile` joined to `Wallet` where `source = 'onchain'` | Every binding the indexer saw while it was running | Gaps for any period the indexer was down longer than its event window (`INDEXER_EVENT_WINDOW_LEDGERS`, default 8,000 ledgers) |
| **Stellar history archives / Hubble** | Everything, permanently | Not a live query; you extract contract events from archived ledgers |
| **The old contract itself**, via `resolve(handle)` | Any handle you can name | Confirms a binding; cannot enumerate one |

The archives are the only complete source, and the only one that is complete
*after* the fact. The indexer database is the fast path. Use the contract to
verify, never to discover.

> **Action item, today:** export a binding snapshot on a schedule and keep the
> exports. One row per binding, `handle,wallet,ledger`, is enough. Reconciling
> three sources during an incident is survivable; discovering that all three are
> incomplete is not.

```bash
# Snapshot from the indexer database (needs DATABASE_URL).
psql "$DATABASE_URL" -At -F',' -c \
  "select p.handle, w.pubkey
     from \"Wallet\" w join \"Profile\" p on p.id = w.\"profileId\"
    where w.source = 'onchain'
    order by p.handle" \
  > "bindings-$(date -u +%Y%m%dT%H%M%SZ).csv"
```

---

## 3. When to migrate — and when not to

Migrating is expensive: every user has to sign again, and every integrator
pinned to the contract id has to be told. Do it only for a defect in the
contract's own behaviour.

| Situation | Migrate? |
| --- | --- |
| A wallet's key is compromised | **No.** The owner calls `release`, or the admin calls `admin_revoke`, then the handle is re-claimed. |
| The admin key is compromised or lost | **No.** `set_admin` rotates moderation authority without touching bindings — it exists precisely so this is not a migration. (Not in the currently deployed wasm; see [`REGISTRY_INTEGRATION.md`](REGISTRY_INTEGRATION.md).) |
| A handle needs removing for moderation | **No.** `admin_revoke`. |
| The registry instance archived and reads fail | **No.** Restore the archived entry; the bindings are intact. Every write path already bumps the instance TTL. |
| A logic bug lets a binding be created, moved, or destroyed without the owner's authorization | **Yes, immediately.** This is the only class that cannot be contained on the current contract. |
| A logic bug is user-visible but does not affect ownership (a wrong error code, a missing event field) | **Probably not.** Weigh it against making every user sign again. Fix it in the next planned deployment, and document the deployed behaviour in the meantime — that is what `REGISTRY_INTEGRATION.md` §2 and §3 already do for the drift between `main` and the pinned wasm. |

---

## 4. The replacement contract

The migration is only safe if re-claiming cannot be raced. Between the
announcement and the last user signing, every handle on the new registry is
unclaimed — and `claim` is first-come. Without a reservation, migration day is an
open squat on every handle in the product.

So the replacement wasm adds two entrypoints (**neither exists in the current
contract; they are part of the migration deployment, and want their own tests and
review**):

```rust
/// Reserve `handle` so that only `wallet` may claim it. Admin-only, and
/// refused once the registry is sealed. This does NOT create a binding:
/// the wallet still signs its own `claim`, so the trust model is unchanged —
/// the admin can only narrow who may claim, never assign ownership.
pub fn admin_reserve(env: Env, handle: String, wallet: Address) -> Result<(), Error>;

/// End the migration: drop every remaining reservation and refuse any further
/// `admin_reserve`. One-way, admin-only. After this the registry behaves
/// exactly like the current one.
pub fn seal(env: Env) -> Result<(), Error>;
```

`claim` gains one check: if a reservation exists for the handle and names a
different wallet, fail. A handle with no reservation stays open to anyone, as
today.

The point of `seal` is that the migration's extra admin power is temporary and
its end is observable on-chain. Publish the seal transaction hash alongside the
new contract id, and the "was this really only a reservation?" question has an
answer anyone can check.

Grace period: **90 days** between reserving and sealing, matched to the
persistent-storage TTL bump the contract already uses (~30 days) plus room for
users who check in monthly.

---

## 5. Cutover

Order matters. Each step is safe to stop at; nothing before step 6 changes what
users see.

**1. Freeze and announce.** Publish the defect, the plan, and the date. If the
defect allows unauthorized binding changes, say so plainly — users need to know
their handle may move under them until the cutover.

**2. Snapshot.** Take a fresh export ([§2](#2-the-precondition-you-have-to-satisfy-today)),
then reconcile the three sources into one `handle,wallet` list. Reconciliation
rules, in order:

- A binding the old contract still `resolve`s is authoritative: whatever the
  snapshot says, `resolve(handle)` is the current owner.
- A binding in the snapshot that no longer resolves was released, revoked, or —
  if the defect permits it — stolen. Check the archived event for the removal
  and whether the removing transaction was authorized by the owner. Unauthorized
  removals are reserved for the *pre-defect* owner.
- A handle in neither is not migrated. It is simply claimable on the new
  registry.

**3. Verify the list against the chain.** Every entry, before anything is
deployed:

```bash
stellar contract invoke --network "$NETWORK" --id "$OLD_CONTRACT_ID" \
  --source "$ACCOUNT" -- resolve --handle "$HANDLE"
# → the wallet in your list, or you do not migrate that entry yet
```

The count has to agree too — `count()` on the old contract is the number of
live bindings, and a list that does not match it is a list that is missing
something:

```bash
stellar contract invoke --network "$NETWORK" --id "$OLD_CONTRACT_ID" \
  --source "$ACCOUNT" -- count
```

**4. Deploy the replacement.** `./infra/deploy-contract.sh` deploys and
initializes in one run and prints the new contract id. Deploy as the intended
admin — `initialize` requires the admin's own signature, and the script refuses
to proceed otherwise.

**5. Reserve.** One `admin_reserve` per entry in the verified list, then re-read
each one back. This is the step to script and to log; a reservation that
silently failed is a handle open to a squatter on cutover day.

**6. Repoint the readers.** Now, and not before:

| Consumer | Change |
| --- | --- |
| Web app | `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` (browser: claim UI) and `REGISTRY_CONTRACT_ID` (server: `/handles`, profile resolution) → redeploy. `NEXT_PUBLIC_*` is baked in at build time, so this is a rebuild, not a restart. |
| Indexer | `INDEXER_REGISTRY_CONTRACT_ID` → restart. **Reset the attestation cursor first** (below), or the worker resumes from a ledger far ahead of the new contract's first event and never sees a single claim. |
| Integrators | Publish the new contract id and wasm hash in [`REGISTRY_INTEGRATION.md`](REGISTRY_INTEGRATION.md) §1, and keep the old row with a "superseded on `<date>`" note. Anyone reading the old id gets stale answers with no error to catch. |

```sql
-- Reset the attestation cursor so the new contract is indexed from its start.
delete from "IndexerCursor" where id = 'attestation';
```

The indexer's first run after the reset scans back `INDEXER_EVENT_WINDOW_LEDGERS`
from the tip. If the new contract has been live longer than that window, raise it
for the first run, or the claims made before it will only reach the database when
those users next appear in another worker's data.

**7. Open re-claiming.** Users claim their reserved handles. Track the
percentage; the tail is long.

**8. Seal**, after the grace period. Publish the transaction hash.

**9. Retire the old contract.** Leave it deployed — it is the audit trail, and
its bindings are what a stale integrator is still reading. Do not `admin_revoke`
bindings on it to "force" the migration: that destroys the record you would need
if the new deployment has to be rolled back, and it does not make anyone's client
point anywhere new.

---

## 6. What users have to do

State this in the announcement, in these terms:

- **Sign one transaction** on the new registry to re-claim the handle. The web
  app's claim flow does it; the handle is held for the signing wallet for 90
  days, so there is no race and no deadline pressure.
- **Nothing else moves.** The profile, the on-chain history and the wallet's
  activity are all derived from the wallet address, not from the registry entry.
  Re-claiming restores the same profile at the same URL.
- **Until they re-claim,** `/p/<handle>` falls back to whatever the indexer and
  curated data can show, and the handle is not resolvable through the new
  registry. Integrators reading the chain directly see it as unbound.
- **After the grace period,** an unclaimed handle is open to anyone, exactly as
  it would have been before it was ever claimed.

Users do **not** prove ownership twice: the reservation is derived from a
signature they already made on the old registry, and the re-claim is the second
and only other signature.

---

## 7. If the migration itself goes wrong

Before step 6 (repointing) there is nothing to roll back — the new contract is
deployed and reserved, and no reader is using it.

After step 6, roll back by reverting the three environment variables to the old
contract id, redeploying the web app, resetting the attestation cursor again, and
restarting the indexer. Bindings claimed on the new registry survive there; they
are simply not read while the old id is in force. The old contract's bindings were
never destroyed, which is why step 9 says to leave it alone.

The failure that is *not* recoverable this way is a bad reservation list — handles
reserved for the wrong wallets, discovered after users started claiming. Sealing
is what makes that permanent, so do not seal early, and keep the reconciled list
and its verification output as an artifact of the migration.

---

## 8. Checklist

- [ ] Snapshot exports are running on a schedule and retained (§2)
- [ ] Defect classified as ownership-affecting (§3)
- [ ] Announcement published, with the date
- [ ] Fresh snapshot taken and reconciled from all three sources
- [ ] Every entry verified against `resolve`, and the total against `count()`
- [ ] `admin_reserve` / `seal` implemented, tested, reviewed
- [ ] Replacement deployed and initialized by the intended admin
- [ ] Reservations written and read back, with a log
- [ ] Attestation cursor reset
- [ ] `NEXT_PUBLIC_IDENTITY_REGISTRY_ID`, `REGISTRY_CONTRACT_ID`, `INDEXER_REGISTRY_CONTRACT_ID` updated; web rebuilt; indexer restarted
- [ ] `REGISTRY_INTEGRATION.md` §1 updated, old deployment marked superseded
- [ ] Re-claim rate tracked through the grace period
- [ ] Sealed, with the transaction hash published
- [ ] Old contract left deployed and documented as superseded
