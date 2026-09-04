# Deploy wallet attachment policy

`Wallet.pubkey` is `@unique` across the whole table, so one deploy account can
be bound to exactly one profile at a time. That constraint forces a decision
rather than making one: what happens when a second profile tries to attach a
wallet somebody already holds?

Answering it badly is a hijack surface in both directions. Refuse every
contested attachment and the first person to link an address holds it forever,
with no path for the real owner. Move the row on any second attempt and proving
control of a key becomes a way to take a wallet off a profile that already
displays it — which is worse, because the profile's deployment history moves
with it.

This is the policy Signet enforces, where it lives, and how a genuinely
contested wallet gets released.

## The three cases

Attachment happens in one place: `completePairing` in
[`apps/web/lib/server/pairing.ts`](../apps/web/lib/server/pairing.ts), the CLI
pairing flow's final step. Nothing else writes a `Wallet` row for a deploy
account.

By the time the policy applies, the caller has already produced **two
independent proofs** — an approved pairing (the browser session proving the
person owns the handle) and a valid SEP-10 challenge signed by the deploy
account itself (proving they control the key). Neither proof alone reaches this
point.

| Case                                               | Outcome                                                               | Reason code              | HTTP |
| -------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ | ---- |
| Wallet is unbound                                  | Attached to the approved profile, `source: 'cli'`, `isPrimary: false` | —                        | 200  |
| Wallet is already bound to **this** profile        | No-op; the existing row is returned unchanged                         | —                        | 200  |
| Wallet is already bound to a **different** profile | Refused; nothing is written                                           | `wallet-bound-elsewhere` | 409  |

**Same profile is idempotent, not an error.** Re-running `signet link` from a
machine that already linked — a re-clone, a second checkout, a CI runner that
lost its config — is a normal thing to do, and it succeeds without writing
anything.

**A different profile is refused even with full proof of key control.** This is
the deliberate half. Proving you hold the key is necessary to attach a wallet,
but it is _not_ sufficient to take one, because the signature says nothing about
which profile should hold it. Transfer-with-audit was the alternative
considered; it was rejected because a silent transfer is indistinguishable from
a theft to everyone reading the losing profile, and an audited one still moves
the deployment history before anybody can object.

**No proof is refused earlier**, before the policy is reached at all — an
unsigned or invalid challenge fails as `bad-challenge` (401), and a pairing the
browser never approved fails as `not-approved` (409).

## Releasing a contested wallet

Refusal is not a dead end. The profile currently holding the wallet releases it
from the dashboard's **Wallets** page, via `account.unlinkWallet`; the address
is then unbound and the next `signet link` attaches it normally.

Two limits on that path, both in `unlinkWallet` in
[`apps/web/lib/server/account.ts`](../apps/web/lib/server/account.ts):

- **Only the holder can release it.** A caller asking to unlink a wallet on
  someone else's profile gets `Wallet not found` — the same error as a wallet
  that does not exist, so the call cannot be used to probe who holds an address.
- **The primary wallet cannot be unlinked.** It is the address the handle was
  claimed with, so releasing it is a registry operation on-chain, not a database
  delete.

## Error text does not identify the holder

`wallet-bound-elsewhere` renders as _"This deploy account is already bound to a
different profile"_ — no handle, no address, no profile id. The refusal has to
say enough that the operator knows why their link failed, and no more: an error
that named the holder would turn the pairing endpoint into a lookup from
deploy address to identity, for anyone willing to sign a challenge.

The same reasoning is why `unlinkWallet` answers `Wallet not found` rather than
distinguishing "not yours" from "does not exist".

## Concurrency

Two completions racing the same pairing cannot both win. The pairing row is
flipped `approved → completed` with a conditional update inside the
transaction that writes the wallet, so the second caller sees zero rows updated
and aborts as `already-completed` before touching `Wallet`. The signed
challenge is independently spent through the nonce store, so a replayed request
carrying the same XDR is rejected as `replayed`.

## Logging

Every refusal is logged at `warn` as `pairing.completeRejected` with the pairing
`state` and the reason code; a successful attachment is logged at `info` as
`pairing.completed` with `state`, `profileId`, and `pubkey`. A profile being
repeatedly targeted by contested attachments is therefore visible in the logs
without the error responses ever having disclosed anything to the caller.

## Tests

The policy is covered in
[`apps/web/lib/server/pairing.test.ts`](../apps/web/lib/server/pairing.test.ts),
against an in-memory `PairingStore`: the unbound attach, the same-profile no-op,
and the cross-profile refusal, alongside the concurrency and replay cases above.
