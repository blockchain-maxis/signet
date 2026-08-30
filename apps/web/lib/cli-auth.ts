import { createHmac, randomBytes } from 'node:crypto';
import { getAuthSecret } from './auth';

const b64url = (b: Buffer): string => b.toString('base64url');
const hmac = (data: string): Buffer => createHmac('sha256', getAuthSecret()).update(data).digest();

export function createCliLinkToken(pubkey: string, profileId: string): string {
  const nonce = randomBytes(16).toString('hex');
  const issued = Date.now();
  const data = `${pubkey}|${profileId}|${issued}|${nonce}`;
  const tag = b64url(hmac(data));
  return b64url(Buffer.from(`${data}|${tag}`));
}

export function verifyCliLinkToken(token: string): { pubkey: string; profileId: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 5) return null;
    
    const [pubkey, profileId, issuedStr, nonce, tag] = parts;
    if (!pubkey || !profileId || !issuedStr || !nonce || !tag) return null;
    
    const issued = parseInt(issuedStr, 10);
    if (Date.now() - issued > 5 * 60 * 1000) return null;
    
    const expectedData = `${pubkey}|${profileId}|${issuedStr}|${nonce}`;
    const expectedTag = b64url(hmac(expectedData));
    
    if (tag !== expectedTag) return null;
    
    return { pubkey, profileId };
  } catch {
    return null;
  }
}

export function createCliPairingCode(pubkey: string, network: string, state: string): string {
  const nonce = randomBytes(16).toString('hex');
  const issued = Date.now();
  const data = `${pubkey}|${network}|${state}|${issued}|${nonce}`;
  const tag = b64url(hmac(data));
  return b64url(Buffer.from(`${data}|${tag}`));
}

export function verifyCliPairingCode(code: string): { pubkey: string; network: string; state: string } | null {
  try {
    const decoded = Buffer.from(code, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 6) return null;
    
    const [pubkey, network, state, issuedStr, nonce, tag] = parts;
    if (!pubkey || !network || !state || !issuedStr || !nonce || !tag) return null;
    
    const issued = parseInt(issuedStr, 10);
    if (Date.now() - issued > 10 * 60 * 1000) return null;
    
    const expectedData = `${pubkey}|${network}|${state}|${issuedStr}|${nonce}`;
    const expectedTag = b64url(hmac(expectedData));
    
    if (tag !== expectedTag) return null;
    
    return { pubkey, network, state };
  } catch {
    return null;
  }
}
