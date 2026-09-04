# Signet API Reference

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
  stats: ProfileStats;
  operations: Operation[];
  truncated: boolean;
  cap: number | null;
  source: 'database' | 'horizon' | 'demo' | 'none';
} | null
```
Profile fields: `name`, `wallet`, `bio`, `joined`. Stats: `invocations`, `uniqueFunctions`, `reputation` (0–100).

The operations window is bounded by the layer that answered (`source`). When `truncated` is true the record is partial: `cap` is the limit that cut it short, `operations` holds only the most recent ones, and every count in `stats` is a lower bound rather than a total. Clients must not present a truncated record as a complete one.

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
