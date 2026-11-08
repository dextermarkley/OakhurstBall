// Data-access helpers for players, admins, check-ins.
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1, BY_SUB, keys, gsi } from './ddb.js';
import { queryAll, queryPage } from './page.js';
import { newId } from './crypto.js';
import { paymentView } from './views.js';
import { cleanName } from './text.js';
import type { Contact } from './contact.js';
import type { Admin, CheckIn, Payment, Player, PublicPlayer } from './types.js';

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// ───────────────────────────── Players ──────────────────────────────────────
export async function getPlayer(playerId: string): Promise<Player | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.playerProfile(playerId) }));
  return (r.Item as Player) ?? null;
}

/**
 * The player linked to a Cognito account. Runs on almost every request, so it is
 * an index lookup (BySub: cognitoSub → key), not a read of every player.
 * The index is eventually consistent; a profile created a moment ago (sign-up)
 * may not be in it yet, so a miss falls back to the paged player list.
 */
export async function getPlayerByCognitoSub(sub: string): Promise<Player | null> {
  if (!sub) return null;
  let found: Record<string, any>[] = [];
  try {
    const hit = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: BY_SUB,
        KeyConditionExpression: 'cognitoSub = :s',
        ExpressionAttributeValues: { ':s': sub },
      }),
    );
    found = hit.Items ?? [];
  } catch (err: any) {
    // While a new index is still being built, DynamoDB rejects queries on it;
    // use the slow path below until it's ready instead of failing the request.
    if (err?.name !== 'ValidationException' && err?.name !== 'ResourceNotFoundException') throw err;
    console.warn('BySub index not ready; using the player list', err?.name);
  }
  const k = found.find((i) => String(i.PK).startsWith('PLAYER#') && i.SK === 'PROFILE');
  if (k) return getPlayer(String(k.PK).slice('PLAYER#'.length));
  const all = await queryAll<Player>({
    TableName: TABLE,
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :pk',
    FilterExpression: 'cognitoSub = :sub',
    ExpressionAttributeValues: { ':pk': 'PLAYER', ':sub': sub },
  });
  return all[0] ?? null;
}

export async function createPlayer(input: {
  name: string;
  email?: string;
  phone?: string;
  pinHash?: string;
  cognitoSub?: string;
  emergencyName?: string;
  emergencyPhone?: string;
  /** Approved members can use the chat. Self sign-ups start unapproved. */
  approved?: boolean;
}): Promise<Player> {
  const playerId = newId();
  const name = cleanName(input.name) || 'New Player';
  const player: Player = {
    playerId,
    name,
    email: input.email,
    phone: input.phone,
    pinHash: input.pinHash,
    cognitoSub: input.cognitoSub,
    ...(input.emergencyName ? { emergencyName: input.emergencyName } : {}),
    ...(input.emergencyPhone ? { emergencyPhone: input.emergencyPhone } : {}),
    balanceCents: 0,
    active: true,
    approved: !!input.approved,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...keys.playerProfile(playerId),
        ...player,
        ...gsi.playerList(),
        GSI1SK: name.toLowerCase(),
      },
    }),
  );
  return player;
}

const publicPlayer = (i: any): PublicPlayer => ({
  playerId: i.playerId,
  name: i.name,
  balanceCents: i.balanceCents,
  waiverVersion: i.waiverVersion,
  rulesVersion: i.rulesVersion,
  agreedAt: i.agreedAt,
  approved: !!i.approved,
  email: i.email,
  createdAt: i.createdAt,
  hasAccount: !!i.cognitoSub,
  // Contact details: admin pages only (the kiosk maps players to id/name/flag).
  phone: i.phone,
  emergencyName: i.emergencyName,
  emergencyPhone: i.emergencyPhone,
});

const PLAYER_LIST = {
  TableName: TABLE,
  IndexName: GSI1,
  KeyConditionExpression: 'GSI1PK = :pk',
  ExpressionAttributeValues: { ':pk': 'PLAYER' },
};

/** One page of players, A–Z by name (no hashes). */
export async function listPlayersPage(cursor: unknown, limit: number) {
  const r = await queryPage(PLAYER_LIST, { cursor, limit, partition: { GSI1PK: 'PLAYER' } });
  return { players: r.items.map(publicPlayer), nextCursor: r.nextCursor };
}

/** playerId → owes money (balance below zero), read for just these players. */
export async function negativeFlags(playerIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ids = [...new Set(playerIds)];
  for (let i = 0; i < ids.length; i += 100) {
    // BatchGet takes 100 keys; retry whatever DynamoDB hands back unprocessed.
    let keysLeft: any[] = ids.slice(i, i + 100).map((id) => keys.playerProfile(id));
    for (let tries = 0; keysLeft.length && tries < 5; tries++) {
      const r = await ddb.send(
        new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keysLeft, ProjectionExpression: 'playerId, balanceCents' } } }),
      );
      for (const it of r.Responses?.[TABLE] ?? []) out.set(it.playerId, Number(it.balanceCents ?? 0) < 0);
      keysLeft = (r.UnprocessedKeys?.[TABLE]?.Keys as any[]) ?? [];
    }
  }
  return out;
}

/** Every player, A–Z by name (server-side use). */
export async function listPlayers(): Promise<PublicPlayer[]> {
  return (await queryAll(PLAYER_LIST)).map(publicPlayer);
}

/** Approve (or un-approve) a player for members-only features like the chat. */
export async function setPlayerApproved(playerId: string, approved: boolean, byName: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: keys.playerProfile(playerId),
        UpdateExpression: approved
          ? 'SET approved = :t, approvedAt = :now, approvedBy = :by, updatedAt = :now'
          : 'SET approved = :f, updatedAt = :now REMOVE approvedAt, approvedBy',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: approved
          ? { ':t': true, ':now': nowIso(), ':by': byName }
          : { ':f': false, ':now': nowIso() },
      }),
    );
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Cognito subs of approved players (for chat notifications). */
export async function approvedSubs(): Promise<Set<string>> {
  const out = new Set<string>();
  let start: Record<string, any> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk',
        FilterExpression: 'approved = :t',
        ExpressionAttributeValues: { ':pk': 'PLAYER', ':t': true },
        ProjectionExpression: 'cognitoSub',
        ExclusiveStartKey: start,
      }),
    );
    for (const i of r.Items ?? []) if (i.cognitoSub) out.add(i.cognitoSub);
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

/** Save a player's phone + emergency contact (validated by checkContact). */
export async function setPlayerContact(playerId: string, c: Contact): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: keys.playerProfile(playerId),
      UpdateExpression: 'SET phone = :p, emergencyName = :n, emergencyPhone = :e, contactAt = :now, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':p': c.phone, ':n': c.emergencyName, ':e': c.emergencyPhone, ':now': nowIso() },
    }),
  );
}

export async function setPlayerPin(playerId: string, pinHash: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: keys.playerProfile(playerId),
      UpdateExpression: 'SET pinHash = :h, updatedAt = :now',
      ExpressionAttributeValues: { ':h': pinHash, ':now': nowIso() },
    }),
  );
}

// ───────────────────────────── Admins ───────────────────────────────────────
const adminItems = () =>
  queryAll({ TableName: TABLE, IndexName: GSI1, KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': 'ADMIN' } });
export async function getAdmin(adminId: string): Promise<Admin | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.adminProfile(adminId) }));
  return (r.Item as Admin) ?? null;
}

export async function listAdmins(): Promise<Array<{ adminId: string; name: string }>> {
  return (await adminItems())
    .filter((a: any) => a.active)
    .map((a: any) => ({ adminId: a.adminId, name: a.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Admin page list: includes the email so organizers can see where links go. */
export async function listAdminsDetailed(): Promise<
  Array<{ adminId: string; name: string; email?: string; active: boolean }>
> {
  return (await adminItems())
    .map((a: any) => ({ adminId: a.adminId, name: a.name, email: a.email, active: !!a.active }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Link an admin record to the signed-in admin's Cognito account, so pushes and
 * self-payment checks can match by sub rather than by an email someone could set.
 * Only called for users in the Cognito 'admin' group with a verified email, and
 * only fills an empty cognitoSub (never moves an existing link).
 */
export async function linkAdminSub(email: string, sub: string): Promise<void> {
  const e = email.toLowerCase();
  for (const a of (await adminItems()) as Admin[]) {
    if (a.cognitoSub || a.email?.toLowerCase() !== e) continue;
    await ddb
      .send(
        new UpdateCommand({
          TableName: TABLE,
          Key: keys.adminProfile(a.adminId),
          UpdateExpression: 'SET cognitoSub = :s',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(cognitoSub)',
          ExpressionAttributeValues: { ':s': sub },
        }),
      )
      .catch((err) => {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
      });
  }
}

export async function setAdminEmail(adminId: string, email: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: keys.adminProfile(adminId),
      // A new email may be a different person: drop the old account link; the new
      // owner is linked the next time they sign in (linkAdminSub).
      UpdateExpression: 'SET email = :e REMOVE cognitoSub',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':e': email },
    }),
  );
}

export async function createAdmin(input: {
  name: string;
  email: string;
  phone?: string;
  cognitoSub?: string;
}): Promise<Admin> {
  const adminId = newId();
  const name = cleanName(input.name) || 'Admin';
  const admin: Admin = {
    adminId,
    name,
    email: input.email,
    phone: input.phone,
    cognitoSub: input.cognitoSub,
    active: true,
    createdAt: nowIso(),
  };
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...keys.adminProfile(adminId),
        ...admin,
        ...gsi.adminList(),
        GSI1SK: name.toLowerCase(),
      },
    }),
  );
  return admin;
}

// ───────────────────────────── Check-ins ────────────────────────────────────
/** Today's date at the club (YYYY-MM-DD), so "a new day" starts at local midnight. */
export function clubDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.CLUB_TZ ?? 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Check-ins are per gym session — see sessions.ts.

const checkinView = (i: any) => ({
  eventDate: i.eventDate,
  at: i.at,
  source: i.source,
  feeCents: i.feeCents ?? 0,
  sessionId: i.sessionId,
  coveredBy: i.coveredBy,
  ...(i.freeDay ? { freeDay: true } : {}),
});

/**
 * Totals for the player page without reading their whole history:
 *   checkinCount  all-time, a counter on the profile (each check-in ADDs 1).
 *                 Profiles from before the counter get an exact count once
 *                 (checkinCountV marks it), after which the counter is kept.
 *   byMonth       check-ins per month (YYYY-MM) since the start of the month
 *                 five months ago: a bounded range read, not the full history.
 */
export async function checkinStats(player: Player & { checkinCount?: number; checkinCountV?: number }) {
  const pk = `PLAYER#${player.playerId}`;
  let count = player.checkinCount ?? 0;
  if (!player.checkinCountV) {
    count = 0;
    let start: Record<string, any> | undefined;
    do {
      const r = await ddb.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': pk, ':sk': 'CHECKIN#' },
          Select: 'COUNT',
          ExclusiveStartKey: start,
        }),
      );
      count += r.Count ?? 0;
      start = r.LastEvaluatedKey;
    } while (start);
    await ddb
      .send(
        new UpdateCommand({
          TableName: TABLE,
          Key: keys.playerProfile(player.playerId),
          UpdateExpression: 'SET checkinCount = :n, checkinCountV = :v',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(checkinCountV)',
          ExpressionAttributeValues: { ':n': count, ':v': 1 },
        }),
      )
      .catch((err) => {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
      });
  }
  const d = new Date(`${clubDate()}T12:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 5);
  const from = d.toISOString().slice(0, 10);
  const recent = await queryAll<{ eventDate?: string; at: string }>({
    TableName: TABLE,
    // SK holds the UTC time; start a day early and bucket by club date below.
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
    ExpressionAttributeValues: { ':pk': pk, ':a': `CHECKIN#${from.slice(0, 8)}00`, ':b': 'CHECKIN#\uffff' },
    ProjectionExpression: 'eventDate, #at',
    ExpressionAttributeNames: { '#at': 'at' },
  });
  const byMonth: Record<string, number> = {};
  for (const c of recent) {
    const day = c.eventDate ?? clubDate(new Date(c.at));
    if (day < from) continue;
    byMonth[day.slice(0, 7)] = (byMonth[day.slice(0, 7)] ?? 0) + 1;
  }
  return { checkinCount: count, byMonth };
}

/** A page of the player's check-ins, newest first. */
export async function playerCheckins(playerId: string, opts: { cursor?: unknown; limit?: number } = {}) {
  const pk = `PLAYER#${playerId}`;
  const r = await queryPage(
    {
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': 'CHECKIN#' },
      ScanIndexForward: false,
    },
    { cursor: opts.cursor, limit: opts.limit ?? 25, partition: { PK: pk } },
  );
  return { checkins: r.items.map(checkinView), nextCursor: r.nextCursor };
}

/** A page of the player's payments, newest first (allowlisted fields only). */
export async function playerPayments(playerId: string, opts: { cursor?: unknown; limit?: number } = {}) {
  const pk = `PLAYER#${playerId}`;
  const r = await queryPage(
    {
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': 'PAYMENT#' },
      ScanIndexForward: false,
    },
    { cursor: opts.cursor, limit: opts.limit ?? 25, partition: { PK: pk } },
  );
  return { payments: r.items.map(paymentView), nextCursor: r.nextCursor };
}

/**
 * A player's pending payments (raw items, server-side use only). Read from the
 * club-wide pending queue, which stays small, rather than the player's whole
 * payment history, which only grows.
 */
export async function pendingPaymentsOf(playerId: string): Promise<Payment[]> {
  return queryAll<Payment>({
    TableName: TABLE,
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :pk',
    FilterExpression: 'playerId = :p',
    ExpressionAttributeValues: { ':pk': 'PAYMENT_STATUS#pending', ':p': playerId },
  });
}

// ─────────────────────────── Kiosk PIN lockout ──────────────────────────────
// Failed PINs are counted per player in two windows: 5 in 15 minutes locks the
// player for the rest of that window; 20 in a day locks them for the day. That
// turns a 10,000-PIN search into years. Setting a new PIN in the app clears both.
const PIN_WINDOW_SECONDS = 15 * 60;
export const PIN_MAX_SHORT = 5;
export const PIN_MAX_DAY = 20;

function pinFailKeys(playerId: string, nowSec = Math.floor(Date.now() / 1000)) {
  const bucket = Math.floor(nowSec / PIN_WINDOW_SECONDS);
  const day = Math.floor(nowSec / 86400);
  return {
    short: { PK: `PLAYER#${playerId}`, SK: `PINFAIL#Q#${bucket}`, expiresAt: (bucket + 1) * PIN_WINDOW_SECONDS },
    day: { PK: `PLAYER#${playerId}`, SK: `PINFAIL#D#${day}`, expiresAt: (day + 1) * 86400 },
  };
}

/** Whether this player's PIN is locked by too many recent failures, and for how long. */
export async function pinLocked(playerId: string): Promise<'short' | 'day' | null> {
  const k = pinFailKeys(playerId);
  const r = await ddb.send(
    new BatchGetCommand({
      RequestItems: {
        [TABLE]: { Keys: [k.short, k.day].map(({ PK, SK }) => ({ PK, SK })), ProjectionExpression: 'SK, fails' },
      },
    }),
  );
  const got = new Map((r.Responses?.[TABLE] ?? []).map((i: any) => [i.SK, Number(i.fails ?? 0)]));
  if ((got.get(k.day.SK) ?? 0) >= PIN_MAX_DAY) return 'day';
  return (got.get(k.short.SK) ?? 0) >= PIN_MAX_SHORT ? 'short' : null;
}

export async function recordPinFailure(playerId: string): Promise<void> {
  const k = pinFailKeys(playerId);
  await Promise.all(
    [k.short, k.day].map(({ PK, SK, expiresAt }) =>
      ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK, SK },
          UpdateExpression: 'ADD fails :one SET expiresAt = :exp',
          ExpressionAttributeValues: { ':one': 1, ':exp': expiresAt },
        }),
      ),
    ),
  );
}

export async function clearPinFailures(playerId: string): Promise<void> {
  const k = pinFailKeys(playerId);
  await Promise.all(
    [k.short, k.day].map(({ PK, SK }) => ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK, SK } }))),
  );
}

// ─────────────────────────── Admin balance changes ──────────────────────────
/** Largest single manual charge or credit an admin can make. */
export const MAX_ADJUST_CENTS = 100_000; // $1,000

/**
 * Charge (negative delta) or credit (positive) a player's balance by hand, and
 * write an audit row in the same transaction. Returns the new balance, or null if
 * there's no such player.
 */
export async function adminAdjustBalance(
  playerId: string,
  deltaCents: number,
  by: { sub: string; name: string },
  note?: string,
): Promise<number | null> {
  const now = nowIso();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: keys.playerProfile(playerId),
              UpdateExpression: 'ADD balanceCents :d SET updatedAt = :now',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeValues: { ':d': deltaCents, ':now': now },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `PLAYER#${playerId}`,
                SK: `ADJUST#${now}#${newId()}`,
                playerId,
                deltaCents,
                note: note || undefined,
                bySub: by.sub,
                byName: by.name,
                createdAt: now,
              },
            },
          },
        ],
      }),
    );
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') return null;
    throw err;
  }
  return (await getPlayer(playerId))?.balanceCents ?? 0;
}

// ───────────────────────────── Kiosk devices ────────────────────────────────
import { hashToken, makeToken } from './crypto.js';
import type { KioskDevice } from './types.js';

/**
 * Create (or re-provision) a kiosk device. Returns the one-time plaintext token
 * to show the admin — only its scrypt hash is stored. Re-provisioning an existing
 * deviceId rotates the token. Each device lives in its own partition (KIOSK#id)
 * and also carries GSI1PK=KIOSK so the admin page can list them.
 */
export async function createKiosk(
  deviceId: string,
  label: string,
): Promise<{ deviceId: string; label: string; token: string }> {
  const token = makeToken();
  label = cleanName(label);
  const device: KioskDevice = {
    deviceId,
    label: label || deviceId,
    deviceSecretHash: hashToken(token),
    active: true,
  };
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...keys.kioskProfile(deviceId),
        ...device,
        ...gsi.kioskList(),
        GSI1SK: (label || deviceId).toLowerCase(),
        createdAt: nowIso(),
      },
    }),
  );
  return { deviceId, label: device.label, token };
}

/** Remove a kiosk device. False if there was no such device. */
export async function deleteKiosk(deviceId: string): Promise<boolean> {
  const r = await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: keys.kioskProfile(deviceId), ReturnValues: 'ALL_OLD' }),
  );
  return !!r.Attributes;
}

/** List provisioned kiosk devices (no secrets) via GSI1PK=KIOSK. */
export async function listKiosks(): Promise<
  Array<{ deviceId: string; label: string; active: boolean; lastSeenAt?: string }>
> {
  const items = await queryAll({
    TableName: TABLE,
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'KIOSK' },
  });
  return items.map((i: any) => ({
    deviceId: i.deviceId,
    label: i.label,
    active: i.active,
    lastSeenAt: i.lastSeenAt,
  }));
}
