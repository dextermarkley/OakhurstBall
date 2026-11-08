// DynamoDB pagination, done the same way everywhere.
//
// A Query returns at most 1 MB per call (less with Limit) and a LastEvaluatedKey
// when there is more. Ignoring that key silently drops data once a list grows,
// so every Query in the app goes through one of these:
//   queryAll   — server-side lists that are small by nature (admins, a session's
//                attendees, this period's passes). Follows every page, with a
//                hard page cap so a runaway list fails loudly instead of slowly.
//   queryPage  — lists an API returns to a browser. One page plus an opaque
//                cursor; the client asks for the next page with ?cursor=.
import { QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
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
// A cursor is the LastEvaluatedKey, base64url-encoded JSON. It is only a position:
// decodeCursor checks it has exactly the key attributes this query uses, string
// values, and the same partition (PK / GSI1PK) as the query, so a crafted cursor
// can't read another partition or make DynamoDB reject the request.
const KEY_ATTRS = new Set(['PK', 'SK', 'GSI1PK', 'GSI1SK']);

export function encodeCursor(key?: Record<string, any>): string | null {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null;
}

export class BadCursor extends Error {
  constructor() {
    super('That list position is out of date. Reload and try again.');
  }
}

/** Decode and check a cursor. `partition` holds the attribute(s) that must match. */
export function decodeCursor(cursor: unknown, partition: Record<string, string>): Record<string, string> | undefined {
  if (cursor == null || cursor === '') return undefined;
  if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new BadCursor();
  let key: any;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadCursor();
  }
  if (!key || typeof key !== 'object' || Array.isArray(key)) throw new BadCursor();
  for (const [k, v] of Object.entries(key)) {
    if (!KEY_ATTRS.has(k) || typeof v !== 'string') throw new BadCursor();
  }
  for (const [k, v] of Object.entries(partition)) if (key[k] !== v) throw new BadCursor();
  return key;
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
    new QueryCommand({ ...input, Limit: opts.limit, ExclusiveStartKey: decodeCursor(opts.cursor, opts.partition) }),
  );
  return { items: (r.Items ?? []) as T[], nextCursor: encodeCursor(r.LastEvaluatedKey) };
}

/** ?limit= from a request, clamped to 1..max (default when missing or junk). */
export function pageLimit(raw: unknown, dflt: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : dflt;
}
