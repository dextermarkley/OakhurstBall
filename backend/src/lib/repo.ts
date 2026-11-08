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
import { ddb, TABLE, GSI1, keys, gsi } from './ddb.js';
import { newId } from './crypto.js';
import { paymentView } from './views.js';
import { cleanName } from './text.js';
import type { Admin, CheckIn, Payment, Player, PublicPlayer } from './types.js';

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// ───────────────────────────── Players ──────────────────────────────────────
export async function getPlayer(playerId: string): Promise<Player | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.playerProfile(playerId) }));
  return (r.Item as Player) ?? null;
}

export async function getPlayerByCognitoSub(sub: string): Promise<Player | null> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      FilterExpression: 'cognitoSub = :sub',
      ExpressionAttributeValues: { ':pk': 'PLAYER', ':sub': sub },
    }),
  );
  return ((r.Items ?? [])[0] as Player) ?? null;
}

export async function createPlayer(input: {
  name: string;
  email?: string;
  phone?: string;
  pinHash?: string;
  cognitoSub?: string;
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

/** Public list for the kiosk picker (no hashes). */
export async function listPlayers(): Promise<PublicPlayer[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'PLAYER' },
    }),
  );
  return (r.Items ?? [])
    .map((i: any) => ({
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
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
export async function getAdmin(adminId: string): Promise<Admin | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.adminProfile(adminId) }));
  return (r.Item as Admin) ?? null;
}

export async function listAdmins(): Promise<Array<{ adminId: string; name: string }>> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ADMIN' },
    }),
  );
  return (r.Items ?? [])
    .filter((a: any) => a.active)
    .map((a: any) => ({ adminId: a.adminId, name: a.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Admin page list: includes the email so organizers can see where links go. */
export async function listAdminsDetailed(): Promise<
  Array<{ adminId: string; name: string; email?: string; active: boolean }>
> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ADMIN' },
    }),
  );
  return (r.Items ?? [])
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
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ADMIN' },
    }),
  );
  for (const a of (r.Items ?? []) as Admin[]) {
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

export async function playerCheckins(playerId: string, limit = 50): Promise<CheckIn[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':sk': 'CHECKIN#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (r.Items ?? []) as CheckIn[];
}

export async function playerPayments(playerId: string, limit = 50) {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':sk': 'PAYMENT#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (r.Items ?? []).map(paymentView);
}

/** A player's pending payments (raw items, server-side use only). */
export async function pendingPaymentsOf(playerId: string): Promise<Payment[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      FilterExpression: '#s = :p',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':sk': 'PAYMENT#', ':p': 'pending' },
    }),
  );
  return (r.Items ?? []) as Payment[];
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
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'KIOSK' },
    }),
  );
  return (r.Items ?? []).map((i: any) => ({
    deviceId: i.deviceId,
    label: i.label,
    active: i.active,
    lastSeenAt: i.lastSeenAt,
  }));
}
