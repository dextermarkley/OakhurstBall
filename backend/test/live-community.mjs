// Live test of announcements/RSVPs and the chat room against the deployed stack.
// Throwaway Cognito users (one admin). Sends NO notifications: the announcement is
// written straight to the table (posting one notifies everyone), edits use
// notify:false, and nobody has chat notifications on. Deletes everything it made.
// Refuses to run while a real announcement is up.
//   AWS_REGION=us-west-2 node test/live-community.mjs
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand, AdminDeleteUserCommand, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const BASE = 'https://www.oakhurst-ball.org';
const TABLE = 'oakhurst';
const POOL = 'us-west-2_sgaAJES20';
const CLIENT = '2fm9q7bir02ib5upgeeelivdii';
const BUCKET = process.env.CHAT_BUCKET ?? 'oakhurstbasketball-chatmedia5bcb02ee-j1khrlkzs6w1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const hex = (n) => randomBytes(n).toString('hex');
const clubDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)?.slice(0, 400)}`}`);
  if (!cond) failures++;
};

const ptr = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'ANNOUNCE' } }))).Item;
if (ptr && ptr.date === clubDate()) {
  console.error('A real announcement is up today; not running.');
  process.exit(2);
}

/** A tiny valid 2x2 PNG. */
function png() {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const users = [];
const players = [];
async function makeUser(label, { admin = false } = {}) {
  const email = `agent-comm-${label}-${hex(3)}@oakhurst-ball.org`;
  const password = `Aa1${hex(12)}`;
  const name = `ZZ Comm ${label}`;
  const u = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: name }],
  }));
  users.push(email);
  const sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  if (admin) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const playerId = hex(12);
  players.push(playerId);
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name, balanceCents: 0, active: true, createdAt: now, updatedAt: now,
    GSI1PK: 'PLAYER', GSI1SK: name.toLowerCase(), cognitoSub: sub,
    approved: true, // chat is members-only
  } }));
  const a = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const H = { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, body: j, headers: r.headers };
  };
  return { call, sub, playerId, name };
}

const annId = hex(12);
const made = { messages: [], keys: [] };

try {
  const admin = await makeUser('admin', { admin: true });
  const p = await makeUser('player');
  const q = await makeUser('other');

  // ── Announcement ──
  let r = await p.call('GET', '/announcement');
  check('no announcement → null, default text offered', r.status === 200 && r.body.announcement === null && r.body.defaultText === 'Ball today OCI - 5:30', r.body);

  r = await admin.call('POST', '/admin/announcement', { text: '   ' });
  check('empty announcement rejected', r.status === 400, r);
  r = await admin.call('POST', '/admin/announcement', { text: 'x'.repeat(281) });
  check('281-char announcement rejected', r.status === 400, r);
  r = await p.call('POST', '/admin/announcement', { text: 'hi' });
  check('players cannot post announcements', r.status === 403, r);

  const now = new Date().toISOString();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `ANN#${annId}`, SK: 'META', announceId: annId, text: 'ZZ test ball 5:30', date: clubDate(),
    createdAt: now, updatedAt: now, createdByName: 'ZZ Comm admin', createdBySub: admin.sub,
  } }));
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: 'CURRENT', SK: 'ANNOUNCE', announceId: annId, date: clubDate() } }));

  r = await p.call('GET', '/announcement');
  check('player sees the announcement', r.body.announcement?.text === 'ZZ test ball 5:30' && r.body.myPlayerId === p.playerId, r.body);

  r = await p.call('POST', '/announcement/rsvp', { announceId: annId, status: 'in' });
  check('player RSVPs in', r.status === 200 && r.body.announcement.rsvps.some((x) => x.playerId === p.playerId && x.status === 'in'), r.body);
  r = await q.call('POST', '/announcement/rsvp', { announceId: annId, status: 'out' });
  check('other RSVPs out, and sees both', r.body.announcement.rsvps.length === 2 && r.body.announcement.rsvps.find((x) => x.name === 'ZZ Comm player')?.status === 'in', r.body);
  r = await q.call('POST', '/announcement/rsvp', { announceId: annId, status: 'maybe' });
  check('bad RSVP status rejected', r.status === 400, r);
  r = await q.call('POST', '/announcement/rsvp', { announceId: hex(12), status: 'in' });
  check('RSVP to a stale announcement → 409', r.status === 409, r);
  r = await q.call('POST', '/announcement/rsvp', { announceId: annId, status: null });
  check('RSVP cleared', r.body.announcement.rsvps.length === 1, r.body);

  r = await admin.call('PUT', '/admin/announcement', { announceId: annId, text: 'ZZ test ball 6:00', notify: false });
  check('admin edits text, RSVPs kept', r.status === 200 && r.body.announcement.text === 'ZZ test ball 6:00' && r.body.announcement.rsvps.length === 1, r.body);
  r = await admin.call('DELETE', '/admin/announcement', { announceId: annId });
  check('admin takes it down', r.status === 200 && r.body.removed === true, r.body);
  r = await p.call('GET', '/announcement');
  check('gone for players', r.body.announcement === null, r.body);

  // ── Chat prefs ──
  r = await p.call('GET', '/chat/prefs');
  check('chat notifications off by default', r.status === 200 && r.body.chatNotify === false, r.body);
  r = await p.call('PUT', '/chat/prefs', { chatNotify: true });
  check('turn chat notifications on', r.body?.chatNotify === true && (await p.call('GET', '/chat/prefs')).body.chatNotify === true, r.body);
  await p.call('PUT', '/chat/prefs', { chatNotify: false });

  // ── Chat messages ──
  r = await p.call('GET', '/chat');
  check('chat loads', r.status === 200 && Array.isArray(r.body.messages) && r.body.mySub === p.sub, r.status);
  const since = r.body.now;
  const after = r.body.messages.at(-1)?.cursor ?? 'MSG#0000-00-00T00:00:00.000Z#000000000000000000000000';

  r = await p.call('POST', '/chat', { text: '   ' });
  check('empty message rejected', r.status === 400, r);
  r = await p.call('POST', '/chat', { text: 'x'.repeat(2001) });
  check('too-long message rejected', r.status === 400, r);
  r = await p.call('POST', '/chat', { text: 'ZZ test: who has the ball? https://example.com' });
  const m1 = r.body?.message;
  if (m1) made.messages.push(m1);
  check('player posts a message', r.status === 201 && m1?.name === 'ZZ Comm player', r);

  r = await q.call('GET', `/chat?after=${encodeURIComponent(after)}&since=${encodeURIComponent(since)}`);
  check('other user polls and gets it', r.status === 200 && r.body.messages.some((x) => x.messageId === m1?.messageId), r.body);
  r = await q.call('GET', '/chat?after=bogus&since=x');
  check('bad poll cursor rejected', r.status === 400, r);
  r = await q.call('GET', '/chat/latest');
  check('latest cursor for the unread dot', r.body?.cursor === m1?.cursor && r.body?.mine === false, r.body);

  // ── Images ──
  const img = png();
  r = await p.call('POST', '/chat/upload', { contentType: 'image/svg+xml', size: 100 });
  check('SVG uploads refused', r.status === 400, r);
  r = await p.call('POST', '/chat/upload', { contentType: 'image/png', size: 11 * 1024 * 1024 });
  check('over-10 MB uploads refused', r.status === 400, r);
  r = await p.call('POST', '/chat/upload', { contentType: 'image/png', size: img.length });
  const ticket = r.body;
  check('upload ticket issued', r.status === 200 && ticket?.key?.startsWith('chat/') && !!ticket?.url, r);
  made.keys.push(ticket.key);
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
  form.append('file', new Blob([img], { type: 'image/png' }));
  let up = await fetch(ticket.url, { method: 'POST', body: form });
  check('browser-style upload to S3 succeeds', up.status === 204, up.status);

  const bad = new FormData();
  for (const [k, v] of Object.entries(ticket.fields)) bad.append(k, k === 'Content-Type' ? 'text/html' : v);
  bad.append('file', new Blob(['<script>'], { type: 'text/html' }));
  up = await fetch(ticket.url, { method: 'POST', body: bad });
  check('S3 refuses a different content type', up.status === 403, up.status);

  r = await q.call('POST', '/chat', { imageKey: ticket.key, width: 2, height: 2 });
  check("can't post someone else's image", r.status === 400, r);
  r = await p.call('POST', '/chat', { imageKey: ticket.key, width: 2, height: 2, text: 'ZZ meme' });
  const m2 = r.body?.message;
  if (m2) made.messages.push(m2);
  check('post an image message', r.status === 201 && m2?.image?.url?.startsWith('/api/media/') && m2.image.width === 2, r);

  const media = await fetch(BASE + m2.image.url, { redirect: 'manual' });
  const loc = media.headers.get('location') ?? '';
  check('media URL redirects to a signed S3 URL', media.status === 302 && loc.includes('X-Amz-Signature'), media.status);
  const got = await fetch(loc);
  const bytes = Buffer.from(await got.arrayBuffer());
  check('image downloads intact', got.status === 200 && bytes.equals(img) && got.headers.get('content-type') === 'image/png', got.status);
  const nope = await fetch(`${BASE}/api/media/${'0'.repeat(16)}/${'0'.repeat(24)}.png`, { redirect: 'manual' });
  check('bad media path → no redirect to anything real', nope.status === 302 || nope.status === 404, nope.status);
  const trav = await fetch(`${BASE}/api/media/..%2f..%2fsecret`, { redirect: 'manual' });
  // API Gateway normalizes ../ away, so this lands on the SPA, never on S3.
  check('path tricks never redirect to S3', trav.status !== 302 && !trav.headers.get('location'), trav.status);

  // ── Delete ──
  r = await q.call('POST', '/chat/delete', { cursor: m2.cursor });
  check("players can't delete others' messages", r.status === 403, r);
  const delSince = new Date(Date.now() - 1000).toISOString();
  r = await p.call('POST', '/chat/delete', { cursor: m2.cursor });
  check('author deletes their message', r.status === 200, r);
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: ticket.key })).then(() => true, () => false);
  check('its image is deleted from S3', !head, head);
  r = await q.call('GET', `/chat?after=${encodeURIComponent(m1.cursor)}&since=${encodeURIComponent(delSince)}`);
  check('pollers learn about the deletion', r.body?.deleted?.includes(m2.messageId), r.body);
  r = await admin.call('POST', '/chat/delete', { cursor: m1.cursor });
  check('admin deletes anyone’s message', r.status === 200, r);
  made.messages = [];
} catch (err) {
  console.error(err);
  failures++;
} finally {
  // Announcement
  const ann = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `ANN#${annId}` } }));
  for (const it of ann.Items ?? []) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  const cur = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'ANNOUNCE' } }))).Item;
  if (cur?.announceId === annId) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'ANNOUNCE' } }));
  // Chat: any leftover messages, and the deletion markers we caused
  for (const m of made.messages) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: m.cursor } }));
  const dels = await ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)', ExpressionAttributeValues: { ':pk': 'CHAT', ':s': 'DEL#' },
  }));
  const ours = new Set(); // markers created in the last 10 minutes by this run
  for (const d of dels.Items ?? []) if (d.SK > `DEL#${new Date(Date.now() - 600_000).toISOString()}`) ours.add(d.SK);
  for (const sk of ours) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: sk } }));
  for (const k of made.keys) await s3.send(new (await import('@aws-sdk/client-s3')).DeleteObjectCommand({ Bucket: BUCKET, Key: k })).catch(() => {});
  // Users + players + prefs
  for (const pid of players) {
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PLAYER#${pid}` } }));
    for (const it of items.Items ?? []) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  }
  const prefs = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'PREFS' } }));
  for (const u of users) {
    const lu = await cognito.send(new (await import('@aws-sdk/client-cognito-identity-provider')).AdminGetUserCommand({ UserPoolId: POOL, Username: u })).catch(() => null);
    const sub = lu?.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
    if (sub && prefs.Items?.some((x) => x.SK === `USER#${sub}`)) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'PREFS', SK: `USER#${sub}` } }));
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u })).catch(() => {});
  }
  console.log(`cleanup: announcement, ${ours.size} deletion marker(s), ${players.length} players, ${users.length} users`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
