# `/api/v1` design principles

This is the contract every `/api/v1` endpoint is written against. It is written
before any endpoint exists so that each later issue makes the same choices — what
an error looks like, how paging works, what a cache may keep, which changes are
breaking — and so reviewers have one document to hold a PR to.

`/api/v1` is Signet's **public, read-only** API. It is not the app's own
plumbing: tRPC and `/api/cli/*` stay as they are and are **not** a public
contract (see [What is not part of v1](#what-is-not-part-of-v1)).

Terms: "must" and "must not" are requirements a PR is reviewed against; "should"
is the default a PR may depart from with a stated reason.

## Versioning

- The **major version is in the path**: `/api/v1/…`. There is no version header
  and no version query parameter.
- Within v1 **only additive changes** are allowed:
  - new endpoints;
  - new **optional** response fields;
  - new values of an enum that is documented as **open** (clients must treat an
    unknown value as "other", never as an error). An enum documented as closed
    (for example the error codes below) gains a value only in a new major version.
- These need `/api/v2`, never a quiet edit to v1:
  - removing or renaming a field;
  - changing a field's type or the meaning of its value;
  - making an optional field required, or an optional parameter required;
  - tightening a limit below what the docs promise.
- **Deprecation** is announced with the `Deprecation` response header (the date
  the endpoint or field was deprecated) and `Sunset` (the date it stops
  working), with **at least 6 months** between the two. A deprecated thing keeps
  working, unchanged, until its sunset date.

## Envelope

A success is:

```json
{ "data": {}, "meta": {} }
```

`data` is always present. `meta` is present only when it has something to say
(pagination, completeness, source — see below); its absence means "nothing to
report", never "unknown".

An error is:

```json
{ "error": { "code": "not_found", "message": "No profile for handle 'nobody'.", "details": {} } }
```

`code` and `message` are always present; `details` is optional and only ever
carries structured, non-secret context. A response has **either** `data` **or**
`error`, never both. `message` is for a developer reading a log, not for
end-user display, and is not a stable string — clients branch on `code`.

The error codes are a **closed** list. Each maps to exactly one HTTP status:

| `code`         | HTTP status | Meaning                                                                            | Retry?              |
| -------------- | ----------- | ---------------------------------------------------------------------------------- | ------------------- |
| `bad_request`  | 400         | The request is malformed or a parameter is invalid                                 | No                  |
| `not_found`    | 404         | The resource does not exist (or, for handles, is not currently bound)              | No                  |
| `rate_limited` | 429         | The caller is over budget; see [Rate limits](#rate-limits)                         | After `Retry-After` |
| `unavailable`  | 503         | A dependency (database, chain RPC, Horizon) could not answer; the API itself is up | Yes, with backoff   |
| `internal`     | 500         | A bug in Signet. The response carries no internals                                 | Maybe               |

Worked example of each:

```http
HTTP/1.1 400 Bad Request
{ "error": { "code": "bad_request", "message": "limit must be between 1 and 100.", "details": { "parameter": "limit", "max": 100 } } }
```

```http
HTTP/1.1 404 Not Found
{ "error": { "code": "not_found", "message": "No profile for handle 'nobody'." } }
```

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 37
{ "error": { "code": "rate_limited", "message": "Too many requests. Retry in 37 seconds.", "details": { "retryAfter": 37 } } }
```

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 5
{ "error": { "code": "unavailable", "message": "The indexer database could not be reached.", "details": { "dependency": "database" } } }
```

```http
HTTP/1.1 500 Internal Server Error
{ "error": { "code": "internal", "message": "Something went wrong. Try again later." } }
```

A stack trace, SQL, a connection string or an RPC URL must never appear in
`message` or `details`.

## JSON rules

- **camelCase** for every key.
- **Timestamps** are ISO-8601 in UTC with a `Z` suffix and millisecond
  precision, e.g. `2026-09-30T14:03:22.000Z`. Never epoch numbers, never local
  offsets.
- **Addresses** (accounts and contracts) are StrKey strings (`G…`, `C…`), exactly
  as Stellar prints them.
- **Absent values are explicit `null`**, not a missing key. A client can rely on
  every documented key being present. (This is why adding an optional field is
  additive: old clients ignore it; a field that is sometimes missing is a
  different shape every time.)
- **Network is a name**: every response whose answer depends on a deployment
  carries `network` as `"testnet"` or `"mainnet"`, never a passphrase. Passphrases
  are for signing, and are not part of this read API.
- **Amounts** are strings in Stellar's own precision, never floats.
- Unknown request parameters are **ignored**, not rejected, so a new optional
  parameter is additive.

## Pagination

Lists page with an **opaque `cursor`** plus a `limit`:

- `limit` defaults to **25** and is at most **100**; a larger value is a
  `bad_request`, not silently clamped.
- `cursor` is an opaque string the server handed out; clients must not parse or
  construct one. Its format may change without notice.
- The next page is `meta.nextCursor`, which is `null` on the last page.

```http
GET /api/v1/handles/ada/operations?limit=2
```

```json
{
  "data": [
    { "hash": "5c1f…", "function": "transfer", "createdAt": "2026-09-30T14:03:22.000Z" },
    { "hash": "9a07…", "function": "mint", "createdAt": "2026-09-29T08:41:10.000Z" }
  ],
  "meta": {
    "network": "testnet",
    "source": "database",
    "nextCursor": "eyJvIjoyfQ",
    "truncated": false,
    "cap": null
  }
}
```

Following the cursor:

```http
GET /api/v1/handles/ada/operations?limit=2&cursor=eyJvIjoyfQ
```

```json
{
  "data": [{ "hash": "e2d4…", "function": "transfer", "createdAt": "2026-09-27T19:55:03.000Z" }],
  "meta": {
    "network": "testnet",
    "source": "database",
    "nextCursor": null,
    "truncated": false,
    "cap": null
  }
}
```

### Bounded reads

Some reads are bounded by the layer underneath them: the indexer query takes the
newest N rows per wallet, and Horizon paging stops at its own cap. Where that is
true, `meta` carries `truncated` and `cap` with **the same meaning as
`OperationsResult` in `apps/web/lib/profiles.ts`**:

- `truncated: true` means a cap cut the record short — the list is a partial
  history and a count derived from it is a floor ("at least N"), never a total;
- `cap` is the cap that produced the truncation, or `null` when nothing was
  capped.

Paging never lifts a cap: the cursor walks the bounded window, and
`nextCursor: null` with `truncated: true` means "this is all the window holds",
not "this is everything that exists".

## Completeness

`meta.source` says which layer answered, on every read whose answer depends on
it: one of `database` (the indexer), `horizon`, or `chain` (Soroban RPC / the
registry contract). The layers do not have the same reach or freshness, so a
client that cares about completeness must be able to tell. `source` is an **open**
enum: a new layer may be added, so an unknown value means "some other layer".

A read that has no such dependency (a static spec addressed by WASM hash) omits
`source`.

## CORS

- `Access-Control-Allow-Origin: *` on `GET`, `HEAD` and `OPTIONS` only.
- **No credentials**: `Access-Control-Allow-Credentials` is never sent, and v1
  reads nothing from cookies or `Authorization` for data access, so a wildcard
  origin exposes nothing an unauthenticated `curl` could not fetch.
- v1 has **no mutating endpoints**. A `POST`, `PUT`, `PATCH` or `DELETE` to
  `/api/v1` is answered `405` (envelope error `bad_request`) with an `Allow`
  header, and gets no CORS grant.
- `OPTIONS` answers `204` with `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
  and a `Access-Control-Max-Age` of one day.

## Caching

Every response sets `Cache-Control` explicitly; nothing relies on a heuristic.
The class of endpoint decides the policy:

| Class                                                              | `Cache-Control`                                 | Why                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------- |
| Immutable content addressed by hash (a contract spec by WASM hash) | `public, max-age=31536000, immutable`           | The address is the content; it can never change                       |
| Profile and activity data                                          | `public, max-age=30, stale-while-revalidate=60` | Short-lived: fresh enough for a profile page, cheap for a busy handle |
| Health and status                                                  | `no-store`                                      | A cached "ok" is a lie                                                |
| Errors                                                             | `no-store`                                      | A transient `503` must not stick                                      |

Beyond that:

- Cacheable responses carry a **weak `ETag`** (`W/"…"`) and honour
  `If-None-Match` with `304`. Weak, because the body may be re-serialised by an
  intermediary without changing meaning.
- `Vary` lists every request header that can change the body. v1 has none that
  do today, so the header is `Vary: Accept-Encoding` only; adding a
  representation-changing header means adding it to `Vary` in the same PR.
- A response whose answer came from a degraded layer (`meta.source` is not the
  preferred one because the preferred one failed) is served `no-store`, so a
  fallback is never pinned in a cache.

## Rate limits

- **Anonymous** callers get a per-IP budget. The budget is per endpoint class,
  documented next to the endpoint, and never lower than what the docs promise
  (see [Versioning](#versioning)).
- An optional **API key tier** (#651) raises the budget for a caller who
  identifies themselves. The key is a rate-limit identity, not a permission: it
  unlocks no data an anonymous caller cannot read.
- Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset` (seconds until the window resets), so a client can pace
  itself before it is refused.
- A refusal is `429` with the `rate_limited` error above and a `Retry-After`
  header in seconds.

```http
HTTP/1.1 200 OK
RateLimit-Limit: 60
RateLimit-Remaining: 41
RateLimit-Reset: 23
```

## What is not part of v1

- **tRPC and `/api/cli/*`** stay for the app's own UI and for the CLI. They are
  free to change with the code that calls them and are **not** a public contract
  (#650). Nothing in this document applies to them, and a third party must not
  build on them.
- **The reputation heuristic** is intentionally **not** in v1 (see #628). A score
  is an opinion that will be revised; freezing one behind an additive-only
  contract would either freeze a bad heuristic or break the contract. v1 exposes
  the facts a heuristic would be computed from, not the verdict.
- **Writes.** v1 has no mutating endpoints; claiming and linking happen through
  the web app and the CLI.
