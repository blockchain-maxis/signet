# Internal tRPC procedures used by the Signet web app. Not a public API: no stability guarantee, may change in any release. Integrators: use /api/v1 (see docs/API_V1.md).

Generated from the tRPC router — do not edit by hand. Regenerate with `pnpm run docs:generate`.

---

## `health`

- **Type:** `query`
- **Auth:** `public`

### Input

None

### Output

```ts
{ ok: true; service: "signet"; ts: number }
```

---

## `profile.byHandle`

- **Type:** `query`
- **Auth:** `public`

### Input

```ts
{ handle: string }
```
A well-formed handle: 1–32 chars of `[a-z0-9_-]`. Validated by `handleInput()`.

### Output

```ts
{
  handle: string;
  profile: Profile;
  stats: ProfileStatsResult;
  operations: Operation[];
  truncated: boolean;
  cap: number | null;
  source: 'database' | 'horizon' | 'none';
} | null
```
Profile fields: `name`, `wallet`, `bio`, `joined`. Stats: `invocations`, `uniqueFunctions`, `reputation` (0–100), `exact`, and `retentionWindowDays`.

The operations window is bounded by the layer that answered (`source`). When `truncated` is true, `cap` is the limit that cut the operation list short. `stats.exact` says whether the stats exactly cover their represented scope. When `stats.retentionWindowDays` is non-null, that scope is the most recent N days retained by the indexer rather than lifetime history, and clients must label it as such. When `stats.exact` is false, the stats may be lower bounds from a capped read.

---

## `profile.list`

- **Type:** `query`
- **Auth:** `public`

### Input

None

### Output

```ts
string[]
```
Array of all registered handles.

---

## `account.apiKeys.create`

- **Type:** `mutation`
- **Auth:** `protected`

### Input

```ts
{ name: string }
```
Required and trimmed; at most 64 characters (`MAX_API_KEY_NAME`). An empty or longer name is `BAD_REQUEST`.

### Output

```ts
{
  key: string;
  apiKey: {
    id: string;
    name: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
  };
}
```
`key` is the full plaintext key (`sgk_<8 chars>_<43 chars>`), returned **once**: it is never shown or retrievable again, so store it now. `apiKey` is the listed record, with only the prefix. At most 5 keys are active at a time (`MAX_ACTIVE_API_KEYS`); creating another is `BAD_REQUEST` until one is revoked. A wallet with no profile gets `PRECONDITION_FAILED`.

---

## `account.apiKeys.list`

- **Type:** `query`
- **Auth:** `protected`

### Input

None (session cookie carries the identity)

### Output

```ts
{
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}[]
```
The account's active keys, newest first. `prefix` is what the key starts with (`sgk_ab12cd34_`) so keys can be told apart; the secret itself is never listed. A wallet with no profile on this deployment gets `PRECONDITION_FAILED`.

---

## `account.apiKeys.revoke`

- **Type:** `mutation`
- **Auth:** `protected`

### Input

```ts
{ id: string }
```
The id of one of the signed-in account's own keys.

### Output

```ts
{ id: string }
```
The revoked key's id. A key belonging to another profile is `NOT_FOUND`, the same as an unknown id. A wallet with no profile gets `PRECONDITION_FAILED`.

---

## `account.me`

- **Type:** `query`
- **Auth:** `protected`

### Input

None (session cookie carries the identity)

### Output

```ts
{
  address: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
}
```

---

## `account.unlinkWallet`

- **Type:** `mutation`
- **Auth:** `protected`

### Input

```ts
{ wallet: string }
```
A Stellar public key (`G…`, 56 chars) for a non-primary wallet bound to the signed-in profile. Validated by `walletInput()`.

### Output

```ts
void
```
Resolves to nothing on success. Refuses the primary wallet (unlinking it is a registry operation) and any wallet bound to another profile, which gets the same `Wallet not found` as an unknown key.

---

## `account.update`

- **Type:** `mutation`
- **Auth:** `protected`

### Input

```ts
{ displayName: string | null; bio: string | null }
```
`displayName`: max 80 chars. `bio`: max 280 chars. Validated by `normalizeAccountUpdate()`.

### Output

```ts
{
  address: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
}
```

---

## `registry.count`

- **Type:** `query`
- **Auth:** `public`

### Input

None

### Output

```ts
{ count: number | null }
```
The registry's own binding counter — an upper bound, not a live total (a
binding that archives unaccessed is never subtracted). `null` means the
registry could not be read, which is not the same as zero; the TypeScript
SDK's `countRegistryEntries()` coerces a failed query to `{ count: 0 }`,
so prefer this endpoint where the distinction matters.

---

## `registry.lookup`

- **Type:** `query`
- **Auth:** `public`

### Input

```ts
{ wallet: string }
```
A Stellar public key (`G…`, 56 chars). Validated by `walletInput()`.

### Output

```ts
{ handle: string; wallet: string } | null
```
`null` when the on-chain directory is unreachable or the wallet holds no handle.

---

## `registry.resolve`

- **Type:** `query`
- **Auth:** `public`

### Input

```ts
{ handle: string }
```
A well-formed handle: 1–32 chars of `[a-z0-9_-]`. Validated by `handleInput()`.

### Output

```ts
{ handle: string; wallet: string } | null
```
`null` when the on-chain directory is unreachable or the handle is unclaimed.

---
