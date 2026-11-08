// DynamoDB pagination, done the same way everywhere.
//
// A Query returns at most 1 MB per call (less with Limit) and a LastEvaluatedKey
// when there is more. Ignoring that key silently drops data once a list grows,
// so every Query in the app goes through one of these:
//   queryAll   — server-side lists that are small by nature (admins, a session's
//                attendees, this period's passes). Follows every page, with a
//                hard page cap so a runaway list fails loudly instead of slowly.
//   queryPage  — lists an API returns to a browser. One page plus an opaque,
//                encrypted cursor; the client asks for the next page with ?cursor=.
import { QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ddb } from './ddb.js';

/** Pages followed before queryAll gives up (1 MB each: far beyond this app's lists). */
const MAX_PAGES = 50;

export async function queryAll<T = Record<string, any>>(input: QueryCommandInput): Promise<T[]> {
  const out: T[] = [];
  let start: Record<string, any> | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: start }));
    out.push(...((r.Items ?? []) as T[]));
    start = r.LastEvaluatedKey;
    if (!start) return out;
  }
  throw new Error(`queryAll: more than ${MAX_PAGES} pages for ${JSON.stringify(input.ExpressionAttributeValues ?? {})}`);
}

// ── Cursors ──
// A cursor carries DynamoDB's LastEvaluatedKey, sealed with AES-256-GCM:
//   base64url( version(1) | iv(12) | ciphertext | tag(16) )
//   plaintext = JSON { k: <key>, x: <expires, unix seconds> }
//   additional data = the query's partition, e.g. {"PK":"PLAYER#…"}
// So a cursor is opaque (no ids, names or times are visible), can't be edited
// or forged (GCM rejects any change), only opens for the same list it came
// from, and expires after CURSOR_TTL_SECONDS. The key is a per-stack SSM
// SecureString (CURSOR_KEY_PARAM); tests can set CURSOR_KEY (64 hex chars).
// After opening, the key's attributes are still checked as a second line.
const KEY_ATTRS = new Set(['PK', 'SK', 'GSI1PK', 'GSI1SK']);
const CURSOR_VERSION = 1;
export const CURSOR_TTL_SECONDS = 24 * 3600;

export class BadCursor extends Error {
  constructor() {
    super('That list position is out of date. Reload and try again.');
  }
}

const aad = (partition: Record<string, string>) =>
  Buffer.from(JSON.stringify(Object.keys(partition).sort().map((k) => [k, partition[k]])));

/** Seal a key for this partition (pure: the 32-byte secret is passed in). */
export function sealCursor(
  key: Record<string, any> | undefined,
  partition: Record<string, string>,
  secret: Buffer,
  nowSec = Math.floor(Date.now() / 1000),
): string | null {
  if (!key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secret, iv);
  c.setAAD(aad(partition));
  const body = Buffer.concat([c.update(JSON.stringify({ k: key, x: nowSec + CURSOR_TTL_SECONDS })), c.final()]);
  return Buffer.concat([Buffer.from([CURSOR_VERSION]), iv, body, c.getAuthTag()]).toString('base64url');
}

/** Open and check a cursor (pure). Undefined for "first page"; BadCursor otherwise. */
export function openCursor(
  cursor: unknown,
  partition: Record<string, string>,
  secret: Buffer,
  nowSec = Math.floor(Date.now() / 1000),
): Record<string, string> | undefined {
  if (cursor == null || cursor === '') return undefined;
  if (typeof cursor !== 'string' || cursor.length > 1400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new BadCursor();
  const raw = Buffer.from(cursor, 'base64url');
  if (raw.length < 1 + 12 + 16 + 1 || raw[0] !== CURSOR_VERSION) throw new BadCursor();
  let payload: any;
  try {
    const d = createDecipheriv('aes-256-gcm', secret, raw.subarray(1, 13));
    d.setAAD(aad(partition));
    d.setAuthTag(raw.subarray(raw.length - 16));
    payload = JSON.parse(Buffer.concat([d.update(raw.subarray(13, raw.length - 16)), d.final()]).toString('utf8'));
  } catch {
    throw new BadCursor(); // edited, forged, wrong key, or from another list
  }
  if (!payload || typeof payload.x !== 'number' || payload.x < nowSec) throw new BadCursor();
  const key = payload.k;
  if (!key || typeof key !== 'object' || Array.isArray(key)) throw new BadCursor();
  for (const [k, v] of Object.entries(key)) if (!KEY_ATTRS.has(k) || typeof v !== 'string') throw new BadCursor();
  for (const [k, v] of Object.entries(partition)) if (key[k] !== v) throw new BadCursor();
  return key as Record<string, string>;
}

const ssm = new SSMClient({});
let secretP: Promise<Buffer> | undefined;
/** The stack's cursor key: CURSOR_KEY (tests) or the CURSOR_KEY_PARAM SecureString, cached. */
function cursorSecret(): Promise<Buffer> {
  secretP ??= (async () => {
    const hex =
      process.env.CURSOR_KEY ??
      (await ssm.send(new GetParameterCommand({ Name: process.env.CURSOR_KEY_PARAM ?? '/oakhurst/cursor/key', WithDecryption: true })))
        .Parameter?.Value?.trim();
    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error('cursor key missing or not 64 hex chars');
    return Buffer.from(hex, 'hex');
  })().catch((err) => {
    secretP = undefined; // retry on the next request
    throw err;
  });
  return secretP;
}

export const encodeCursor = async (key: Record<string, any> | undefined, partition: Record<string, string>) =>
  key ? sealCursor(key, partition, await cursorSecret()) : null;

export async function decodeCursor(cursor: unknown, partition: Record<string, string>) {
  if (cursor == null || cursor === '') return undefined;
  return openCursor(cursor, partition, await cursorSecret());
}

/**
 * One page of a Query. `partition` is the partition the query reads (e.g.
 * { PK: 'PLAYER#…' } or { GSI1PK: 'SESSION' }), used to check the cursor.
 */
export async function queryPage<T = Record<string, any>>(
  input: QueryCommandInput,
  opts: { cursor?: unknown; limit: number; partition: Record<string, string> },
): Promise<{ items: T[]; nextCursor: string | null }> {
  const r = await ddb.send(
    new QueryCommand({ ...input, Limit: opts.limit, ExclusiveStartKey: await decodeCursor(opts.cursor, opts.partition) }),
  );
  return { items: (r.Items ?? []) as T[], nextCursor: await encodeCursor(r.LastEvaluatedKey, opts.partition) };
}

/** ?limit= from a request, clamped to 1..max (default when missing or junk). */
export function pageLimit(raw: unknown, dflt: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : dflt;
}
