// PIN and device-secret hashing using node:crypto scrypt (no native deps).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384; // scrypt cost
const KEYLEN = 32;

/** Hash a PIN or secret. Returns "salt:hash" hex. */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(secret, salt, KEYLEN, { N });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Constant-time verify. */
export function verifySecret(secret: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = scryptSync(secret, salt, KEYLEN, { N });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Hash for high-entropy random tokens (kiosk device tokens). A 192-bit random
 * token can't be guessed, so a slow KDF adds nothing but CPU cost per request.
 */
export const hashToken = (token: string) => 'sha256:' + createHash('sha256').update(token).digest('hex');

/** Constant-time check of a token against hashToken() output. */
export function verifyToken(token: string, stored: string): boolean {
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** URL-safe opaque token for magic confirm links. */
export function makeToken(): string {
  return randomBytes(24).toString('base64url');
}

export function newId(): string {
  return randomBytes(12).toString('hex');
}
