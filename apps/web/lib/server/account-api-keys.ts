/**
 * The signed-in account's API keys (#652), for the dashboard: list, create
 * and revoke, over `lib/api-keys.ts` (#651).
 *
 * A key belongs to the profile of the signed-in wallet, so a wallet with no
 * profile row (a handle the indexer has not synced, or none at all) has no
 * keys to manage. At most `MAX_ACTIVE_API_KEYS` are active at once, enforced
 * here, not in the page. The plaintext key leaves this module once, in
 * `create`'s answer; lists carry only the prefix.
 */
import {
  createApiKey,
  defaultApiKeyStore,
  listApiKeys,
  revokeApiKey,
  API_KEY_PREFIX,
  type ApiKeyRecord,
  type ApiKeyStore,
} from '../api-keys.ts';

export const MAX_ACTIVE_API_KEYS = 5;
export const MAX_API_KEY_NAME = 64;

/** A key as the dashboard lists it: never the hash, never the secret. */
export interface AccountApiKey {
  id: string;
  name: string;
  /** What the key starts with, `sgk_ab12cd34_`, to tell keys apart. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Why a request was refused; the router maps each to a tRPC code. */
export class ApiKeyAccountError extends Error {
  readonly reason: 'no-profile' | 'limit' | 'invalid-name' | 'not-found';
  constructor(reason: ApiKeyAccountError['reason'], message: string) {
    super(message);
    this.name = 'ApiKeyAccountError';
    this.reason = reason;
  }
}

export interface AccountApiKeyDeps {
  store?: ApiKeyStore;
  /** The profile the wallet belongs to, or null when it has none. */
  findProfileId?: (address: string) => Promise<string | null>;
}

async function prismaProfileId(address: string): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  const { prisma } = await import('@signet/db');
  const wallet = await prisma.wallet.findUnique({
    where: { pubkey: address },
    select: { profileId: true },
  });
  return wallet?.profileId ?? null;
}

async function profileOf(address: string, deps: AccountApiKeyDeps): Promise<string> {
  const id = await (deps.findProfileId ?? prismaProfileId)(address);
  if (!id) {
    throw new ApiKeyAccountError(
      'no-profile',
      'API keys belong to a profile, and this wallet has none on this deployment yet.',
    );
  }
  return id;
}

function toAccountKey(r: ApiKeyRecord): AccountApiKey {
  return {
    id: r.id,
    name: r.name,
    prefix: `${API_KEY_PREFIX}${r.prefix}_`,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  };
}

const active = (keys: ApiKeyRecord[]) => keys.filter((k) => k.revokedAt === null);

/** The account's active keys, newest first. */
export async function listAccountApiKeys(
  address: string,
  deps: AccountApiKeyDeps = {},
): Promise<AccountApiKey[]> {
  const profileId = await profileOf(address, deps);
  const keys = await listApiKeys(profileId, deps.store ?? defaultApiKeyStore);
  return active(keys).map(toAccountKey);
}

/** Creates a key; the answer carries the full key, which is never shown again. */
export async function createAccountApiKey(
  address: string,
  rawName: unknown,
  deps: AccountApiKeyDeps = {},
): Promise<{ key: string; apiKey: AccountApiKey }> {
  const name = String(rawName ?? '').trim();
  if (!name) throw new ApiKeyAccountError('invalid-name', 'Give the key a name.');
  if (name.length > MAX_API_KEY_NAME) {
    throw new ApiKeyAccountError(
      'invalid-name',
      `A key name is at most ${MAX_API_KEY_NAME} characters.`,
    );
  }
  const store = deps.store ?? defaultApiKeyStore;
  const profileId = await profileOf(address, deps);
  if (active(await listApiKeys(profileId, store)).length >= MAX_ACTIVE_API_KEYS) {
    throw new ApiKeyAccountError(
      'limit',
      `You already have ${MAX_ACTIVE_API_KEYS} active keys. Revoke one to create another.`,
    );
  }
  const { key, record } = await createApiKey(profileId, name, store);
  return { key, apiKey: toAccountKey(record) };
}

/** Revokes one of the account's own keys. Another profile's key is "not found". */
export async function revokeAccountApiKey(
  address: string,
  id: unknown,
  deps: AccountApiKeyDeps = {},
): Promise<{ id: string }> {
  const keyId = String(id ?? '');
  const profileId = await profileOf(address, deps);
  const revoked = await revokeApiKey(profileId, keyId, deps.store ?? defaultApiKeyStore);
  if (!revoked) throw new ApiKeyAccountError('not-found', 'No such key on this account.');
  return { id: revoked.id };
}
