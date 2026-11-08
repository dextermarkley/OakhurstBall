// Data-access helpers for players, admins, check-ins.
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1, keys, gsi } from './ddb.js';
import { newId } from './crypto.js';
import type { Admin, CheckIn, Player, PublicPlayer } from './types.js';

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
  const player: Player = {
    playerId,
    name: input.name,
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
        GSI1SK: input.name.toLowerCase(),
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

/** Adjust balance by a signed delta (e.g. charge dues → negative). */
export async function adjustBalance(playerId: string, deltaCents: number): Promise<number> {
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: keys.playerProfile(playerId),
      UpdateExpression: 'ADD balanceCents :d SET updatedAt = :now',
      ExpressionAttributeValues: { ':d': deltaCents, ':now': nowIso() },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return (r.Attributes as any)?.balanceCents ?? 0;
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

export async function setAdminEmail(adminId: string, email: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: keys.adminProfile(adminId),
      UpdateExpression: 'SET email = :e',
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
  const admin: Admin = {
    adminId,
    name: input.name,
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
        GSI1SK: input.name.toLowerCase(),
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
  return r.Items ?? [];
}

// ───────────────────────────── Kiosk devices ────────────────────────────────
import { hashSecret, makeToken } from './crypto.js';
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
  const device: KioskDevice = {
    deviceId,
    label: label || deviceId,
    deviceSecretHash: hashSecret(token),
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
