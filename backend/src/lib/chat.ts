// Club chat room: text + images (memes), polled by open clients, with opt-in
// push notifications.
//
//   PK=CHAT   SK=MSG#<iso>#<id>   a message
//   PK=CHAT   SK=DEL#<iso>#<id>   "message <id> was deleted" (TTL 2 days) so
//                                 polling clients drop it too
//   PK=CHAT   SK=UPD#<iso>#<id>   "message <id> changed" (a reaction, or the message
//                                 it replies to was deleted); TTL 2 days
//   PK=CHAT   SK=RPL#<id>#<replyId>  reply <replyId> quotes <id>, so deleting <id>
//                                 can blank the quote in every reply
// Reactions live on the message as one string set per emoji: rx_<utf8 hex> =
// {cognito subs}. ADD / DELETE on a top-level set needs no read-modify-write.
//   PK=PREFS  SK=USER#<sub>       { chatNotify, chatSeenAt }
//
// Images go straight from the browser to a private S3 bucket with a presigned
// POST (type and size enforced by S3), under chat/<owner>/<id>.<ext>. They are
// shown through /api/media/<owner>/<id>.<ext>, which redirects to a short-lived
// signed S3 URL, so the image URL in a message never changes.
import { createHash } from 'node:crypto';
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, TABLE } from './ddb.js';
import { queryAll } from './page.js';
import { newId } from './crypto.js';
import { sendPush, toUser } from './push.js';
import { approvedSubs } from './repo.js';

const s3 = new S3Client({});
const BUCKET = process.env.CHAT_BUCKET ?? '';

export const MAX_TEXT = 2000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOADS_PER_DAY = 40;
const MAX_POSTS_PER_MINUTE = 12;
const MAX_REACTIONS_PER_MINUTE = 60;
/** Different emojis on one message. */
export const MAX_REACTION_KINDS = 20;
const SNIPPET = 120;
const MARKER_TTL = 2 * 86400;
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
export interface Reaction {
  emoji: string;
  /** Cognito subs of who reacted (clients compare with their own). */
  subs: string[];
}
export interface ReplyQuote {
  cursor: string;
  messageId: string;
  sub: string;
  name: string;
  /** First SNIPPET characters; absent for a photo, or once the original is deleted. */
  text?: string;
  image?: boolean;
  deleted?: boolean;
}
export interface ChatMessage {
  messageId: string;
  cursor: string;
  sub: string;
  name: string;
  text?: string;
  image?: ChatImage;
  reactions?: Reaction[];
  replyTo?: ReplyQuote;
  createdAt: string;
}

import { RX, attrEmoji, cleanEmoji, reactionAttr } from './emoji.js';
export { cleanEmoji, reactionAttr };

/** Short stable folder per user, so the owner can be checked from the key. */
export const ownerDir = (sub: string) => createHash('sha256').update(sub).digest('hex').slice(0, 16);

const MEDIA_RE = /^([a-f0-9]{16})\/([a-f0-9]{24})\.(jpg|png|gif|webp)$/;

function reactionsOf(i: any): Reaction[] | undefined {
  const out: Reaction[] = [];
  for (const [k, v] of Object.entries(i)) {
    if (!k.startsWith(RX)) continue;
    const subs = [...((v as Set<string>) ?? [])];
    if (subs.length) out.push({ emoji: attrEmoji(k), subs });
  }
  return out.length ? out.sort((a, b) => b.subs.length - a.subs.length || a.emoji.localeCompare(b.emoji)) : undefined;
}

function view(i: any): ChatMessage {
  return {
    reactions: reactionsOf(i),
    replyTo: i.replyTo,
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

/** What changed since the client's last poll: new, deleted and changed messages. */
export async function changesSince(after: string, sinceIso: string) {
  const [fresh, dels, upds] = await Promise.all([
    query('SK BETWEEN :lo AND :hi', { ':lo': after, ':hi': 'MSG#\uffff' }, true, 200),
    query('SK BETWEEN :lo AND :hi', { ':lo': `DEL#${sinceIso}`, ':hi': 'DEL#\uffff' }, true, 200),
    query('SK BETWEEN :lo AND :hi', { ':lo': `UPD#${sinceIso}`, ':hi': 'UPD#\uffff' }, false, 200),
  ]);
  const freshSKs = new Set(fresh.map((i) => i.SK));
  // Changed messages the client already has (new ones arrive whole in `messages`).
  const changed = [...new Set(upds.map((u) => u.msgSK as string))].filter((sk) => !freshSKs.has(sk)).slice(0, 100);
  const updated: ChatMessage[] = [];
  if (changed.length) {
    let keys: any[] = changed.map((SK) => ({ PK: 'CHAT', SK }));
    for (let t = 0; keys.length && t < 5; t++) {
      const r = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } }));
      updated.push(...(r.Responses?.[TABLE] ?? []).map(view));
      keys = (r.UnprocessedKeys?.[TABLE]?.Keys as any[]) ?? [];
    }
  }
  return {
    messages: fresh.filter((i) => i.SK !== after).map(view),
    deleted: dels.map((d) => d.messageId as string),
    updated,
  };
}

/** Tell polling clients a message changed. */
async function markUpdated(msgSK: string, messageId: string) {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: 'CHAT',
        SK: `UPD#${new Date().toISOString()}#${messageId}#${newId().slice(0, 6)}`,
        msgSK,
        messageId,
        expiresAt: Math.floor(Date.now() / 1000) + MARKER_TTL,
      },
    }),
  );
}

async function underQuota(kind: string, sub: string, max: number): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60000);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: 'QUOTA', SK: `${kind}#${ownerDir(sub)}#${minute}` },
        UpdateExpression: 'ADD n :one SET expiresAt = :exp',
        ConditionExpression: 'attribute_not_exists(n) OR n < :max',
        ExpressionAttributeValues: { ':one': 1, ':max': max, ':exp': (minute + 2) * 60 },
      }),
    );
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

const MSG_RE = /^MSG#[^#]+#[a-f0-9]{24}$/;

/** Add or remove the caller's reaction. Returns the message as it is now. */
export async function react(cursor: unknown, emojiRaw: unknown, on: boolean, sub: string) {
  if (typeof cursor !== 'string' || !MSG_RE.test(cursor)) return { error: 'notfound' as const };
  const emoji = cleanEmoji(emojiRaw);
  if (!emoji) return { error: 'That isn’t an emoji' };
  if (!(await underQuota('RX', sub, MAX_REACTIONS_PER_MINUTE))) return { error: 'Slow down a little.' };
  const attr = reactionAttr(emoji);
  if (on) {
    const cur = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: cursor } }))).Item;
    if (!cur) return { error: 'notfound' as const };
    const kinds = Object.keys(cur).filter((k) => k.startsWith(RX));
    if (!kinds.includes(attr) && kinds.length >= MAX_REACTION_KINDS) return { error: 'That message has enough different reactions. Pick one already there.' };
  }
  try {
    const r = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: 'CHAT', SK: cursor },
        UpdateExpression: `${on ? 'ADD' : 'DELETE'} #a :me`,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#a': attr },
        ExpressionAttributeValues: { ':me': new Set([sub]) },
        ReturnValues: 'ALL_NEW',
      }),
    );
    // An emptied set is removed by DynamoDB, so the reaction just disappears.
    await markUpdated(cursor, r.Attributes!.messageId);
    return { message: view(r.Attributes) };
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return { error: 'notfound' as const };
    throw err;
  }
}

export function checkUpload(contentType: unknown, size: unknown): string | null {
  if (!BUCKET) return 'Photo uploads aren’t available right now';
  if (!IMAGE_TYPES[String(contentType)]) return 'Photos must be JPEG, PNG, GIF or WebP';
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return 'That image can’t be used. Try a different one.';
  if (n > MAX_IMAGE_BYTES) return 'Photos must be 10 MB or smaller';
  return null;
}

/** A presigned POST the browser uses to upload one image straight to S3. */
export async function uploadTicket(sub: string, contentType: string) {
  // Daily cap per person, so one account can't fill the bucket.
  const day = new Date().toISOString().slice(0, 10);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: 'QUOTA', SK: `UPLOAD#${ownerDir(sub)}#${day}` },
        UpdateExpression: 'ADD n :one SET expiresAt = :exp',
        ConditionExpression: 'attribute_not_exists(n) OR n < :max',
        ExpressionAttributeValues: { ':one': 1, ':max': MAX_UPLOADS_PER_DAY, ':exp': Math.floor(Date.now() / 1000) + 2 * 86400 },
      }),
    );
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { error: `You can post up to ${MAX_UPLOADS_PER_DAY} photos a day. Try again tomorrow.` };
    }
    throw err;
  }
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
  replyTo?: unknown;
}): Promise<{ message?: ChatMessage; error?: string; repliedTo?: { sub: string } }> {
  const text = (input.text ?? '').trim();
  if (text.length > MAX_TEXT) return { error: `Messages are limited to ${MAX_TEXT} characters` };
  // At most MAX_POSTS_PER_MINUTE per person (each post can notify everyone).
  if (!(await underQuota('POST', input.sub, MAX_POSTS_PER_MINUTE))) return { error: 'You’re sending messages too fast. Wait a moment.' };
  let replyTo: ReplyQuote | undefined;
  if (input.replyTo != null && input.replyTo !== '') {
    if (typeof input.replyTo !== 'string' || !MSG_RE.test(input.replyTo)) return { error: 'That message can’t be replied to.' };
    const t = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: input.replyTo } }))).Item;
    if (!t) return { error: 'That message was deleted, so you can’t reply to it.' };
    const snip = t.text ? [...String(t.text).replace(/\s+/g, ' ')] : [];
    replyTo = {
      cursor: t.SK,
      messageId: t.messageId,
      sub: t.sub,
      name: t.name,
      text: snip.length ? (snip.length > SNIPPET ? snip.slice(0, SNIPPET - 1).join('') + '…' : snip.join('')) : undefined,
      image: !!t.imageKey || undefined,
    };
  }
  let imageKey: string | undefined;
  if (input.imageKey) {
    const k = String(input.imageKey);
    const m = k.startsWith('chat/') ? MEDIA_RE.exec(k.slice(5)) : null;
    if (!m || m[1] !== ownerDir(input.sub)) return { error: 'That image can’t be used. Try a different one.' };
    try {
      const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: k }));
      if (!h.ContentType?.startsWith('image/') || (h.ContentLength ?? 0) > MAX_IMAGE_BYTES) return { error: 'That image can’t be used. Try a different one.' };
    } catch {
      return { error: 'Image upload did not finish' };
    }
    imageKey = k;
  }
  if (!text && !imageKey) return { error: 'Type a message or add a photo' };
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
    replyTo,
    createdAt,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  if (replyTo) {
    await ddb.send(
      new PutCommand({ TableName: TABLE, Item: { PK: 'CHAT', SK: `RPL#${replyTo.messageId}#${messageId}`, replySK: item.SK } }),
    );
  }
  return { message: view(item), repliedTo: replyTo && replyTo.sub !== input.sub ? { sub: replyTo.sub } : undefined };
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
  // Its own entry in the reply index, if it was a reply.
  if (it.replyTo?.messageId) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: `RPL#${it.replyTo.messageId}#${it.messageId}` } }));
  }
  // Replies quoting it keep the quote's shape but lose its words.
  const replies = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':pk': 'CHAT', ':s': `RPL#${it.messageId}#` },
  });
  for (const rp of replies) {
    await ddb
      .send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: 'CHAT', SK: rp.replySK },
          UpdateExpression: 'SET replyTo.deleted = :t REMOVE replyTo.#tx, replyTo.image',
          ConditionExpression: 'attribute_exists(replyTo)',
          ExpressionAttributeNames: { '#tx': 'text' },
          ExpressionAttributeValues: { ':t': true },
        }),
      )
      .then(() => markUpdated(rp.replySK, String(rp.replySK).split('#').pop()!))
      .catch((err) => {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
      });
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: rp.SK } }));
  }
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
export async function notifyChat(msg: ChatMessage, repliedTo?: { sub: string }) {
  const prefs = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'PREFS' },
  });
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const wanted = new Set(
    prefs
      .filter((p) => p.chatNotify && !(p.chatSeenAt && p.chatSeenAt > cutoff))
      .map((p) => String(p.SK).slice('USER#'.length)),
  );
  wanted.delete(msg.sub);
  const body = msg.text ? (msg.text.length > 140 ? `${msg.text.slice(0, 139)}…` : msg.text) : 'Sent a photo';
  // Someone replied to you: you're told even with chat notifications off,
  // unless you're looking at the chat right now.
  if (repliedTo) {
    wanted.delete(repliedTo.sub);
    const p = prefs.find((x) => x.SK === `USER#${repliedTo.sub}`);
    if (!(p?.chatSeenAt && p.chatSeenAt > cutoff)) {
      await sendPush(toUser(repliedTo.sub), { title: `${msg.name} replied to you`, body, url: '/chat', tag: `reply-${msg.messageId}` });
    }
  }
  if (!wanted.size) return;
  // Only members who can actually open the chat: admins and approved players.
  const approved = await approvedSubs();
  await sendPush((s) => wanted.has(s.sub) && (!!s.isAdmin || approved.has(s.sub)), {
    title: `${msg.name} · Chat`,
    body,
    url: '/chat',
    tag: 'chat',
  });
}
