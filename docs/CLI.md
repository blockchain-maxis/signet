# `signet` CLI — terminal linking

`packages/cli` ships a small `signet` binary whose one command today is
`signet link`: it links a machine running the CLI to your Signet account by
getting **you** to approve the link in a browser.

This page is the contract for the wait that command performs — what it prints,
how long it waits, and what happens when nothing approves in time.

## Running it

```bash
pnpm install
pnpm --filter @signet/web dev            # the link server (port 3000)

# from the workspace root, via the package script:
pnpm --filter @signet/cli link
# or the binary directly:
node packages/cli/bin/signet.ts link --api http://localhost:3000
```

The CLI talks to the Signet web app's linking endpoints. Point it at a
different deployment with `--api <url>` or the `SIGNET_API_URL` environment
variable (default `http://localhost:3000`):

```bash
SIGNET_API_URL=https://signet.example node packages/cli/bin/signet.ts link
```

## What `signet link` prints and why

The command's whole job is to never leave a blank terminal. It prints what it
is waiting for up front:

```
Signet link — waiting for you to approve in your browser
  Pairing code:  KY5WEF4V
  Approve at:    http://localhost:3000/link/KY5WEF4V
  Expires in:    5 minutes (05:00)

If a browser did not open, visit the "Approve at" URL above manually.
```

Then, while it waits, it keeps the terminal live with a countdown refreshed
each poll:

```
⏳ Approval pending… 4:58 remaining · http://localhost:3000/link/KY5WEF4V
```

When you approve in the browser, the next poll sees it and the command
finishes with `✓ Linked!`.

## The wait is bounded — and consistent with the pairing code

The wait is not indefinite. Three facts keep it bounded, and they are all tied
to the same number:

| Fact | Value | Source of truth |
| --- | --- | --- |
| Pairing code stays valid | `LINK_PAIR_TTL_MS` = **5 minutes** | `@signet/types` (`packages/types/src/link.ts`) |
| CLI gives up waiting | same TTL the server returned for the pair | the CLI's deadline is `now + ttlMs` from the server response |
| CLI poll interval | `LINK_POLL_INTERVAL_MS` = **2 seconds** | `@signet/types`, returned to the CLI as `intervalMs` |

The server expires a pairing code at `LINK_PAIR_TTL_MS` after it is created,
and the CLI stops polling on exactly that deadline, so it can never still be
waiting on a code the server can no longer approve. Both halves read the same
constant — see `packages/types/src/link.ts` — and the CLI additionally trusts
the `ttlMs` the server returns, so a server that ever changes the TTL moves
the CLI's wait with it.

## On timeout: how to retry, including the manual URL

If nothing approves before the pairing expires, the command exits non-zero and
says exactly what to do:

```
✗ No approval received before the pairing code expired.
  • The code was valid for 5 minutes (05:00); the CLI waited the full TTL so it can no longer be approved.
  • Open this URL in a browser and approve it, then re-run the command:
      signet link --api http://localhost:3000
    Manual URL: http://localhost:3000/link/KY5WEF4V
```

The **manual URL** (`/link/{pairingCode}`) is always printed — both up front
and on timeout — so a developer whose browser failed to auto-open can still
complete the flow by typing the URL by hand. Re-running `signet link` issues a
fresh pairing code.

Other outcomes fail fast too, with their own message: a browser *rejection*
(`✗ The approval was rejected…`), a pairing that expired server-side before
the CLI noticed, or a link server that cannot be reached (never a hang — the
network call itself is bounded and fails fast).

## The pairing endpoints (server side)

The CLI is the *polling* half; the browser half lives in the web app:

| Endpoint | Who calls it | What it does |
| --- | --- | --- |
| `POST /api/link/device` | CLI | Create a pairing; returns `{ pairingCode, verificationUrl, ttlMs, intervalMs }` |
| `GET /api/link/device/status?code=…` | CLI (every poll) | Returns `{ state: 'pending' \| 'approved' \| 'rejected' \| 'expired' }` |
| `POST /api/link/device/approve` | Browser (approve page) | Marks a code approved; 410 when it has expired |

The pairing store (`apps/web/lib/link-pairing.ts`) is in-memory and
per-process — right for a short, human-paced dev flow, and documented there.
The approve page lives at `/link/{code}`.

## Acceptance checklist

- The CLI says what it is waiting for (pairing code, approval URL, TTL) before
  waiting. ✔ (banner + live countdown)
- The wait times out after a bounded, documented interval. ✔
  (`LINK_PAIR_TTL_MS`, documented above and in `packages/types/src/link.ts`)
- On timeout it prints how to retry, including the manual URL. ✔
- The pairing code's TTL and the CLI timeout are consistent. ✔ (one shared
  constant; CLI deadline = server `ttlMs`)
