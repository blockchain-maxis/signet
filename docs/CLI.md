# CLI pairing: linking a deploy wallet without a loopback callback

`signet link` needs to prove two things before it attaches a deploy wallet to
your handle: that the CLI controls that wallet's key, and that a signed-in
session is authorized to modify its own profile. A loopback callback (the CLI
opens a browser tab, the browser redirects back to a local port the CLI is
listening on) is the smoothest way to deliver that second proof — but it
doesn't work everywhere:

- remote SSH sessions, where the browser and the CLI are on different machines
- dev containers with unmapped ports
- locked-down corporate browsers that block navigation to `localhost`

For these, `apps/web`'s `/api/cli/pair/*` routes and `lib/server/cli-pairing.ts`
implement a fallback that needs no inbound port on the CLI's side at all. Both
of the paths below enforce the same TTL (5 minutes), single-use consumption,
and dual-proof requirements a loopback flow would — they only change how the
CLI *learns* that both proofs were satisfied.

## Protocol

1. **Start a session** — `POST /api/cli/pair/start` with `{ publicKey, network }`.
   Returns `{ pairingCode, pollToken, nonce, expiresAt }`. `pairingCode` is a
   short, human-typeable code for the browser URL; `pollToken` is a long
   secret the CLI keeps to itself.

2. **Prove key ownership** — the CLI signs
   `Signet CLI pairing\nCode: <pairingCode>\nNonce: <nonce>` with the deploy
   wallet's key and calls `POST /api/cli/pair/proof` with
   `{ pollToken, signature }` (base64, ed25519 over the raw message — the same
   convention `verifySignature` uses elsewhere in this codebase). This is the
   first proof.

3. **Approve in the browser** — the developer opens
   `https://<host>/app/link/<pairingCode>` in a signed-in tab. Once the proof
   from step 2 has landed, an "Approve this link" button becomes available;
   clicking it is the second proof (an authenticated session acting on its own
   profile) and links the wallet immediately. The page then shows a
   `completionCode`.

4. **Collect the result**, by whichever path fits the environment:
   - **Poll** — `GET /api/cli/pair/status?pollToken=<pollToken>` returns
     `202 { state: "pending" }` until approved, then `200 { state: "approved",
     result: { publicKey, network, profileId } }` — exactly once.
   - **Manual code** — if polling isn't an option either, the developer copies
     the `completionCode` the browser showed and the CLI calls
     `POST /api/cli/pair/complete` with `{ pairingCode, completionCode }`,
     getting the same `{ state: "approved", result }` shape back.

   Both are read against the same underlying session and share one atomic
   consume step, so only one of them can ever claim the result — a poller and
   a manually-entered code racing for the same session cannot both succeed.

```bash
curl -sX POST https://app.example/api/cli/pair/start \
  -H 'content-type: application/json' \
  -d '{"publicKey":"G...","network":"testnet"}'
# {"pairingCode":"AB3D-9KLM","pollToken":"…","nonce":"…","expiresAt":"…"}

curl -sX POST https://app.example/api/cli/pair/proof \
  -H 'content-type: application/json' \
  -d '{"pollToken":"…","signature":"…"}'

# open https://app.example/app/link/AB3D-9KLM in a signed-in browser tab

curl -s "https://app.example/api/cli/pair/status?pollToken=…"
```

## Scope note

No canonical CLI client exists on `main` yet to wire this protocol into —
several independent, unmerged drafts exist across sibling pull requests (a Go
module under `cli/`, and separate TypeScript packages under `apps/cli/` and
`packages/cli/`), each with its own take on the linking flow. This document
describes the server-side protocol so any of them — or a future consolidated
client — can drive it; it does not attempt to merge or pick between those
drafts, which is a maintainer call.
