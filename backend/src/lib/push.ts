// Web Push notifications for the installed app (desktop, Android, iPhone home screen).
//
// The browser gives us a push subscription (an endpoint on Apple/Google/Mozilla/
// Microsoft's push service plus encryption keys). We store one row per device and
// POST encrypted messages to it, signed with our VAPID key. No push vendor
// account, no fixed cost: the push services are free.
//
// VAPID keys live in SSM (created once, see docs/notifications.md):
//   /oakhurst/push/vapid-public   String
//   /oakhurst/push/vapid-private  SecureString
//
// Table layout: PK = 'PUSH', SK = 'SUB#<sha256(endpoint)>'. A small club has a few
// dozen devices, so "everyone" is one Query.
import { createHash } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';
import { ddb, TABLE } from './ddb.js';

const ssm = new SSMClient({});
const PUBLIC_PARAM = process.env.VAPID_PUBLIC_PARAM ?? '/oakhurst/push/vapid-public';
const PRIVATE_PARAM = process.env.VAPID_PRIVATE_PARAM ?? '/oakhurst/push/vapid-private';

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Cognito user that subscribed. */
  sub: string;
  email?: string;
  playerId?: string;
  isAdmin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Page to open when the notification is clicked (same origin). */
  url?: string;
  /** Same tag replaces an earlier notification instead of stacking. */
  tag?: string;
}

// Only real push services: the Lambda POSTs to this URL, so never an arbitrary host.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** Validate a PushSubscription JSON from the browser. Returns an error or null. */
export function checkSubscription(s: any): string | null {
  if (!s || typeof s !== 'object') return 'subscription required';
  let u: URL;
  try {
    u = new URL(String(s.endpoint ?? ''));
  } catch {
    return 'bad endpoint';
  }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some((h) => h.test(u.hostname))) return 'unsupported push service';
  if (String(s.endpoint).length > 1024) return 'bad endpoint';
  const { p256dh, auth } = s.keys ?? {};
  if (typeof p256dh !== 'string' || !B64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100)
    return 'bad keys';
  if (typeof auth !== 'string' || !B64URL.test(auth) || auth.length < 16 || auth.length > 32) return 'bad keys';
  return null;
}

const subKey = (endpoint: string) => ({
  PK: 'PUSH',
  SK: `SUB#${createHash('sha256').update(endpoint).digest('hex').slice(0, 40)}`,
});

const cache = new Map<string, string>();
async function param(name: string): Promise<string | null> {
  const hit = cache.get(name);
  if (hit) return hit;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const v = r.Parameter?.Value?.trim();
    if (v) cache.set(name, v);
    return v || null;
  } catch (err: any) {
    if (err?.name === 'ParameterNotFound') return null;
    throw err;
  }
}

export const vapidPublicKey = () => param(PUBLIC_PARAM);

/** Store (or refresh) a device. The same endpoint moving to a new user replaces it. */
export async function saveSubscription(
  s: { endpoint: string; keys: { p256dh: string; auth: string } },
  owner: { sub: string; email?: string; playerId?: string; isAdmin?: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  const item: PushSub = {
    endpoint: s.endpoint,
    keys: { p256dh: s.keys.p256dh, auth: s.keys.auth },
    sub: owner.sub,
    email: owner.email?.toLowerCase(),
    playerId: owner.playerId,
    isAdmin: owner.isAdmin,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...subKey(s.endpoint), ...item } }));
}

/** Remove a device, but only one the caller owns. */
export async function deleteSubscription(endpoint: string, sub: string): Promise<boolean> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: subKey(endpoint),
        ConditionExpression: '#o = :sub',
        ExpressionAttributeNames: { '#o': 'sub' },
        ExpressionAttributeValues: { ':sub': sub },
      }),
    );
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function allSubscriptions(): Promise<PushSub[]> {
  const out: PushSub[] = [];
  let start: Record<string, any> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':pk': 'PUSH', ':s': 'SUB#' },
        ExclusiveStartKey: start,
      }),
    );
    out.push(...((r.Items ?? []) as PushSub[]));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

/**
 * Send to every matching device. Never throws: a notification is a courtesy on
 * top of the real action, so a push failure must not fail the request. Devices
 * the push service says are gone (404/410) are deleted.
 */
export async function sendPush(
  filter: (s: PushSub) => boolean,
  msg: PushMessage,
  opts: { urgency?: 'normal' | 'high'; ttlSeconds?: number } = {},
): Promise<{ sent: number; failed: number }> {
  try {
    const [pub, priv] = await Promise.all([param(PUBLIC_PARAM), param(PRIVATE_PARAM)]);
    if (!pub || !priv) return { sent: 0, failed: 0 };
    const targets = (await allSubscriptions()).filter(filter);
    if (!targets.length) return { sent: 0, failed: 0 };
    const subject = process.env.APP_BASE_URL || 'mailto:no-reply@oakhurst-ball.org';
    const payload = JSON.stringify(msg);
    const results = await Promise.allSettled(
      targets.map((t) =>
        webpush.sendNotification({ endpoint: t.endpoint, keys: t.keys }, payload, {
          vapidDetails: { subject, publicKey: pub, privateKey: priv },
          TTL: opts.ttlSeconds ?? 6 * 3600,
          urgency: opts.urgency ?? 'normal',
          timeout: 4000,
        }),
      ),
    );
    let sent = 0;
    let failed = 0;
    await Promise.all(
      results.map(async (r, i) => {
        if (r.status === 'fulfilled') return void sent++;
        failed++;
        const code = (r.reason as any)?.statusCode;
        if (code === 404 || code === 410) {
          await ddb.send(new DeleteCommand({ TableName: TABLE, Key: subKey(targets[i].endpoint) })).catch(() => {});
        } else {
          console.warn('push failed', { code, host: new URL(targets[i].endpoint).hostname });
        }
      }),
    );
    return { sent, failed };
  } catch (err) {
    console.error('push send error', err);
    return { sent: 0, failed: 0 };
  }
}

// ── Who gets what ─────────────────────────────────────────────────────────────
export const toPlayer = (playerId: string) => (s: PushSub) => s.playerId === playerId;
export const toUser = (sub: string) => (s: PushSub) => s.sub === sub;
/** Admin profiles predate Cognito links, so match the login email too. */
export const toAdmin = (a: { cognitoSub?: string; email?: string }) => (s: PushSub) =>
  (!!a.cognitoSub && s.sub === a.cognitoSub) || (!!a.email && s.email === a.email.toLowerCase());
