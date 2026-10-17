import crypto from 'node:crypto';
import { prisma } from '@signet/db';
import {
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  API_KEY_REDACT_PATTERN,
  API_KEY_REGEX,
} from '@signet/types';

export { API_KEY_PATTERN, API_KEY_PREFIX, API_KEY_REDACT_PATTERN, API_KEY_REGEX };

export interface ApiKeyRecord {
  id: string;
  profileId: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ApiKeyStore {
  create(data: {
    profileId: string;
    name: string;
    prefix: string;
    hash: string;
  }): Promise<ApiKeyRecord>;
  listByProfile(profileId: string): Promise<ApiKeyRecord[]>;
  findByPrefix(prefix: string): Promise<ApiKeyRecord[]>;
  revoke(profileId: string, id: string): Promise<ApiKeyRecord | null>;
  touchLastUsed(id: string, date: Date): Promise<void>;
}

export const defaultApiKeyStore: ApiKeyStore = {
  async create(data) {
    return prisma.apiKey.create({ data });
  },
  async listByProfile(profileId) {
    return prisma.apiKey.findMany({
      where: { profileId },
      orderBy: { createdAt: 'desc' },
    });
  },
  async findByPrefix(prefix) {
    return prisma.apiKey.findMany({
      where: { prefix },
    });
  },
  async revoke(profileId, id) {
    const existing = await prisma.apiKey.findFirst({
      where: { id, profileId },
    });
    if (!existing) return null;
    return prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  },
  async touchLastUsed(id, date) {
    await prisma.apiKey.update({
      where: { id },
      data: { lastUsedAt: date },
    });
  },
};

/**
 * Computes the SHA-256 hash of an API key as a hex string.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Compares two strings in constant time to prevent timing attacks.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generates an 8-character alphanumeric prefix for API keys.
 */
function generatePrefix(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Generates a 32-byte base64url random secret string.
 */
function generateSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Creates a new API key for the given profile and name.
 * Plaintext key is returned once in the result and never stored.
 */
export async function createApiKey(
  profileId: string,
  name: string,
  store: ApiKeyStore = defaultApiKeyStore,
): Promise<{ key: string; record: ApiKeyRecord }> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('API key name must not be empty.');
  }

  const prefix = generatePrefix();
  const secret = generateSecret();
  const key = `${API_KEY_PREFIX}${prefix}_${secret}`;
  const hash = hashApiKey(key);

  const record = await store.create({
    profileId,
    name: trimmedName,
    prefix,
    hash,
  });

  return { key, record };
}

/**
 * Lists all API keys belonging to a profile.
 */
export async function listApiKeys(
  profileId: string,
  store: ApiKeyStore = defaultApiKeyStore,
): Promise<ApiKeyRecord[]> {
  return store.listByProfile(profileId);
}

/**
 * Revokes an API key belonging to a profile.
 */
export async function revokeApiKey(
  profileId: string,
  id: string,
  store: ApiKeyStore = defaultApiKeyStore,
): Promise<ApiKeyRecord | null> {
  return store.revoke(profileId, id);
}

export type VerifyApiKeyResult =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; code: 'unauthorized'; reason: string };

/**
 * Verifies an incoming API key token:
 * 1. Validates key format and extracts prefix.
 * 2. Fetches candidate records matching prefix.
 * 3. Uses constant-time hash comparison to identify matching key.
 * 4. Checks whether the key is revoked.
 * 5. Updates lastUsedAt at most once a minute.
 */
export async function verifyApiKey(
  token: string,
  store: ApiKeyStore = defaultApiKeyStore,
): Promise<VerifyApiKeyResult> {
  const match = token.match(API_KEY_REGEX);
  if (!match || !match[1]) {
    return { ok: false, code: 'unauthorized', reason: 'Invalid API key format.' };
  }

  const prefix = match[1];
  const candidates = await store.findByPrefix(prefix);
  if (candidates.length === 0) {
    return { ok: false, code: 'unauthorized', reason: 'API key not found.' };
  }

  const incomingHash = hashApiKey(token);
  let matchedRecord: ApiKeyRecord | null = null;

  for (const candidate of candidates) {
    if (timingSafeEqualString(incomingHash, candidate.hash)) {
      matchedRecord = candidate;
      break;
    }
  }

  if (!matchedRecord) {
    return { ok: false, code: 'unauthorized', reason: 'Invalid API key.' };
  }

  if (matchedRecord.revokedAt !== null) {
    return { ok: false, code: 'unauthorized', reason: 'API key has been revoked.' };
  }

  const now = new Date();
  const shouldUpdateLastUsed =
    !matchedRecord.lastUsedAt || now.getTime() - matchedRecord.lastUsedAt.getTime() > 60_000;

  if (shouldUpdateLastUsed) {
    try {
      await store.touchLastUsed(matchedRecord.id, now);
      matchedRecord.lastUsedAt = now;
    } catch {
      // Best-effort update, ignore error
    }
  }

  return { ok: true, record: matchedRecord };
}
