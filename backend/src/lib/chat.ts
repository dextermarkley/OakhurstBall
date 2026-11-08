// Club chat room: text + images (memes), polled by open clients, with opt-in
// push notifications.
//
//   PK=CHAT   SK=MSG#<iso>#<id>   a message
//   PK=CHAT   SK=DEL#<iso>#<id>   "message <id> was deleted" (TTL 2 days) so
//                                 polling clients drop it too
//   PK=PREFS  SK=USER#<sub>       { chatNotify, chatSeenAt }
//
// Images go straight from the browser to a private S3 bucket with a presigned
// POST (type and size enforced by S3), under chat/<owner>/<id>.<ext>. They are
// shown through /api/media/<owner>/<id>.<ext>, which redirects to a short-lived
// signed S3 URL, so the image URL in a message never changes.
import { createHash } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, TABLE } from './ddb.js';
import { newId } from './crypto.js';
import { sendPush } from './push.js';
import { approvedSubs } from './repo.js';

const s3 = new S3Client({});
const BUCKET = process.env.CHAT_BUCKET ?? '';

export const MAX_TEXT = 2000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PAGE = 50;
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface ChatImage {
  url: string;
  width?: number;
  height?: number;
}
export interface ChatMessage {
  messageId: string;
  cursor: string;
  sub: string;
  name: string;
  text?: string;
  image?: ChatImage;
  createdAt: string;
}

/** Short stable folder per user, so the owner can be checked from the key. */
export const ownerDir = (sub: string) => createHash('sha256').update(sub).digest('hex').slice(0, 16);

const MEDIA_RE = /^([a-f0-9]{16})\/([a-f0-9]{24})\.(jpg|png|gif|webp)$/;

function view(i: any): ChatMessage {
  return {
    messageId: i.messageId,
    cursor: i.SK,
    sub: i.sub,
    name: i.name,
    text: i.text || undefined,
    image: i.imageKey
      ? { url: `/api/media/${String(i.imageKey).slice('chat/'.length)}`, width: i.imageW, height: i.imageH }
      : undefined,
    createdAt: i.createdAt,
  };
}

async function query(cond: string, values: Record<string, string>, forward: boolean, limit?: number) {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: `PK = :pk AND ${cond}`,
      ExpressionAttributeValues: { ':pk': 'CHAT', ...values },
      ScanIndexForward: forward,
      Limit: limit,
    }),
  );
  return r.Items ?? [];
}

/** Newest page (oldest first), or the page before `before`. */
export async function listMessages(before?: string): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const items = await query(
    'SK BETWEEN :lo AND :hi',
    { ':lo': 'MSG#', ':hi': before ? before : 'MSG#\uffff' },
    false,
    PAGE + 1,
  );
  const rows = items.filter((i) => i.SK !== before);
  return { messages: rows.slice(0, PAGE).reverse().map(view), hasMore: rows.length > PAGE };
}

export async function latestMessage(): Promise<{ cursor: string; sub: string } | null> {
  const [i] = await query('SK BETWEEN :lo AND :hi', { ':lo': 'MSG#', ':hi': 'MSG#\uffff' }, false, 1);
  return i ? { cursor: i.SK, sub: i.sub } : null;
}

/** What changed since the client's last poll. */
export async function changesSince(after: string, sinceIso: string) {
  const [fresh, dels] = await Promise.all([
    query('SK BETWEEN :lo AND :hi', { ':lo': after, ':hi': 'MSG#\uffff' }, true, 200),
    query('SK BETWEEN :lo AND :hi', { ':lo': `DEL#${sinceIso}`, ':hi': 'DEL#\uffff' }, true, 200),
  ]);
  return {
    messages: fresh.filter((i) => i.SK !== after).map(view),
    deleted: dels.map((d) => d.messageId as string),
  };
}

export function checkUpload(contentType: unknown, size: unknown): string | null {
  if (!BUCKET) return 'Image uploads are not set up';
  if (!IMAGE_TYPES[String(contentType)]) return 'Only JPEG, PNG, GIF and WebP images';
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return 'size required';
  if (n > MAX_IMAGE_BYTES) return 'Images must be 10 MB or smaller';
  return null;
}

/** A presigned POST the browser uses to upload one image straight to S3. */
export async function uploadTicket(sub: string, contentType: string) {
  const key = `chat/${ownerDir(sub)}/${newId()}.${IMAGE_TYPES[contentType]}`;
  const post = await createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_IMAGE_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=31536000, immutable' },
    Expires: 300,
  });
  return { key, url: post.url, fields: post.fields };
}

export async function postMessage(input: {
  sub: string;
  name: string;
  text?: string;
  imageKey?: string;
  width?: number;
  height?: number;
}): Promise<{ message?: ChatMessage; error?: string }> {
  const text = (input.text ?? '').trim();
  if (text.length > MAX_TEXT) return { error: `Messages are limited to ${MAX_TEXT} characters` };
  let imageKey: string | undefined;
  if (input.imageKey) {
    const k = String(input.imageKey);
    const m = k.startsWith('chat/') ? MEDIA_RE.exec(k.slice(5)) : null;
    if (!m || m[1] !== ownerDir(input.sub)) return { error: 'bad image' };
    try {
      const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: k }));
      if (!h.ContentType?.startsWith('image/') || (h.ContentLength ?? 0) > MAX_IMAGE_BYTES) return { error: 'bad image' };
    } catch {
      return { error: 'Image upload did not finish' };
    }
    imageKey = k;
  }
  if (!text && !imageKey) return { error: 'Say something' };
  const dim = (v: unknown) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 && n < 20000 ? n : undefined;
  };
  const createdAt = new Date().toISOString();
  const messageId = newId();
  const item = {
    PK: 'CHAT',
    SK: `MSG#${createdAt}#${messageId}`,
    messageId,
    sub: input.sub,
    name: input.name,
    text: text || undefined,
    imageKey,
    imageW: imageKey ? dim(input.width) : undefined,
    imageH: imageKey ? dim(input.height) : undefined,
    createdAt,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return { message: view(item) };
}

/** Delete a message: its author, or any admin. */
export async function deleteMessage(cursor: string, by: { sub: string; isAdmin: boolean }) {
  if (!/^MSG#[^#]+#[a-f0-9]{24}$/.test(cursor)) return 'notfound' as const;
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: cursor } }));
  const it = r.Item;
  if (!it) return 'notfound' as const;
  if (it.sub !== by.sub && !by.isAdmin) return 'forbidden' as const;
  const now = new Date().toISOString();
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: cursor } }));
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: 'CHAT',
        SK: `DEL#${now}#${it.messageId}`,
        messageId: it.messageId,
        expiresAt: Math.floor(Date.now() / 1000) + 2 * 86400,
      },
    }),
  );
  if (it.imageKey) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: it.imageKey })).catch(() => {});
  return 'deleted' as const;
}

/** /api/media/<owner>/<id>.<ext> → short-lived signed S3 URL, or null. */
export async function mediaUrl(rest: string): Promise<string | null> {
  if (!BUCKET || !MEDIA_RE.test(rest)) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: `chat/${rest}` }), { expiresIn: 3600 });
}

// ── Preferences + "is looking at the chat right now" ──
const prefKey = (sub: string) => ({ PK: 'PREFS', SK: `USER#${sub}` });

export async function getChatPrefs(sub: string): Promise<{ chatNotify: boolean }> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: prefKey(sub) }));
  return { chatNotify: !!r.Item?.chatNotify };
}

export async function setChatNotify(sub: string, on: boolean) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: prefKey(sub),
      UpdateExpression: 'SET chatNotify = :on',
      ExpressionAttributeValues: { ':on': on },
    }),
  );
}

export async function markChatSeen(sub: string) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: prefKey(sub),
      UpdateExpression: 'SET chatSeenAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
}

/**
 * Notify people who turned chat notifications on, except the sender and anyone
 * who has the chat open right now (polled in the last 30 s). One notification
 * per device that updates in place (tag 'chat'), not a stack of them.
 */
export async function notifyChat(msg: ChatMessage) {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'PREFS' },
    }),
  );
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const wanted = new Set(
    (r.Items ?? [])
      .filter((p) => p.chatNotify && !(p.chatSeenAt && p.chatSeenAt > cutoff))
      .map((p) => String(p.SK).slice('USER#'.length)),
  );
  wanted.delete(msg.sub);
  if (!wanted.size) return;
  // Only members who can actually open the chat: admins and approved players.
  const approved = await approvedSubs();
  const body = msg.text ? (msg.text.length > 140 ? `${msg.text.slice(0, 139)}…` : msg.text) : 'Sent a photo';
  await sendPush((s) => wanted.has(s.sub) && (!!s.isAdmin || approved.has(s.sub)), {
    title: `${msg.name} · Chat`,
    body,
    url: '/chat',
    tag: 'chat',
  });
}
