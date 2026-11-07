// PIN and device-secret hashing using node:crypto scrypt (no native deps).
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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

/** URL-safe opaque token for magic confirm links. */
export function makeToken(): string {
  return randomBytes(24).toString('base64url');
}

export function newId(): string {
  return randomBytes(12).toString('hex');
}
