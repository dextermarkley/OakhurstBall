// Live test of chat reactions and replies (two throwaway approved members):
// toggle on/off, counts across people, other members see changes by polling,
// bad emoji refused, cap on different emojis, replies quote the original, a
// deleted original blanks the quote everywhere, reply to a deleted message
// refused. Cleans up everything it wrote.
//   AWS_REGION=us-west-2 node test/live-chat-rx.mjs
import { randomBytes } from 'node:crypto';
import * as C from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { BASE, TABLE, POOL, CLIENT } from './env.mjs';

const cog = new C.CognitoIdentityProviderClient({ region: 'us-west-2' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const hex = (n) => randomBytes(n).toString('hex');
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)?.slice(0, 300)}`);
  if (!cond) failed++;
};
const users = [];
const players = [];
async function member(label) {
  const email = `agent-rx-${label}-${hex(3)}@oakhurst-ball.org`, password = `Aa1${hex(8)}`;
  const u = await cog.send(new C.AdminCreateUserCommand({ UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: `ZZ Rx ${label}` }] }));
  users.push(email);
  const sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cog.send(new C.AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  const playerId = hex(12);
  players.push(playerId);
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name: `ZZ Rx ${label}`, cognitoSub: sub,
    balanceCents: 0, active: true, approved: true, createdAt: now, updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: `zz rx ${label}`,
    waiverVersion: '2026-11-07', rulesVersion: '2026-11-07.2', agreedAt: now, signedName: 'ZZ Rx',
    phone: '+14155550100', emergencyName: 'ZZ', emergencyPhone: '+15105550100' } }));
  const a = await cog.send(new C.InitiateAuthCommand({ ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }));
  const H = { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { sub, call };
}
const rxOf = (m, e) => m?.reactions?.find((r) => r.emoji === e)?.subs ?? [];
const posted = [];

try {
  const A = await member('a');
  const B = await member('b');
  const start = await B.call('GET', '/api/chat');
  let since = start.body.now;

  let r = await A.call('POST', '/api/chat', { text: `ZZ rx original ${hex(2)}` });
  check('A posts a message', r.status === 201, r);
  const orig = r.body.message;
  posted.push(orig);
  const after = orig.cursor;

  r = await A.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '🏀', on: true });
  check('A reacts 🏀', r.status === 200 && rxOf(r.body.message, '🏀').includes(A.sub), r);
  r = await B.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '🏀', on: true });
  check('B reacts 🏀 too: count 2', rxOf(r.body.message, '🏀').length === 2, r.body);
  r = await B.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '👍🏽', on: true });
  check('B adds 👍🏽 (skin tone)', rxOf(r.body.message, '👍🏽').length === 1, r.body);
  r = await B.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '🏀', on: true });
  check('reacting twice doesn’t double count', rxOf(r.body.message, '🏀').length === 2, r.body);
  r = await A.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '🏀', on: false });
  check('A takes theirs back: count 1', rxOf(r.body.message, '🏀').length === 1 && !rxOf(r.body.message, '🏀').includes(A.sub), r.body);
  r = await B.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '👍🏽', on: false });
  check('last person removing an emoji removes it', !r.body.message.reactions?.some((x) => x.emoji === '👍🏽'), r.body);

  // B's open chat sees the change on its next poll.
  const poll = await B.call('GET', `/api/chat?after=${encodeURIComponent(after)}&since=${encodeURIComponent(since)}`);
  const seen = poll.body.updated?.find((m) => m.messageId === orig.messageId);
  check('polling returns the changed message', poll.status === 200 && rxOf(seen, '🏀').length === 1, poll.body);
  since = poll.body.now;

  for (const bad of ['lol', '👍👍', '', '<script>', 42]) {
    r = await A.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: bad, on: true });
    check(`not an emoji refused: ${JSON.stringify(bad)}`, r.status === 400, r);
  }
  r = await A.call('POST', '/api/chat/react', { cursor: 'MSG#2020-01-01T00:00:00.000Z#000000000000000000000000', emoji: '🏀', on: true });
  check('reacting to a missing message → 404', r.status === 404, r);
  r = await A.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '🏀' });
  check('on missing → 400', r.status === 400, r);

  // Cap on different emojis per message.
  const many = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚'];
  for (const e of many) await A.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: e, on: true });
  r = await A.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '🤯', on: true });
  check('21st different emoji refused', r.status === 400 && /enough different reactions/.test(r.body?.error), r);
  r = await B.call('POST', '/api/chat/react', { cursor: orig.cursor, emoji: '😀', on: true });
  check('…but joining an existing one still works', r.status === 200 && rxOf(r.body.message, '😀').length === 2, r);

  // Replies.
  r = await B.call('POST', '/api/chat', { text: 'ZZ rx I can bring one', replyTo: orig.cursor });
  const reply = r.body?.message;
  posted.push(reply);
  check('B replies: quote has name and text', r.status === 201 && reply.replyTo?.messageId === orig.messageId &&
    reply.replyTo.name === 'ZZ Rx a' && reply.replyTo.text === orig.text, r.body);
  r = await B.call('POST', '/api/chat', { text: 'x', replyTo: 'not-a-cursor' });
  check('reply to junk → 400', r.status === 400, r);

  // Deleting the original blanks the quote in the reply, and polling says so.
  r = await A.call('POST', '/api/chat/delete', { cursor: orig.cursor });
  check('A deletes the original', r.status === 200, r);
  const p2 = await B.call('GET', `/api/chat?after=${encodeURIComponent(reply.cursor)}&since=${encodeURIComponent(since)}`);
  const changed = p2.body.updated?.find((m) => m.messageId === reply.messageId);
  check('reply now quotes a deleted message, with no text', changed?.replyTo?.deleted === true && !changed.replyTo.text, p2.body);
  check('original listed as deleted', p2.body.deleted?.includes(orig.messageId), p2.body);
  r = await B.call('POST', '/api/chat', { text: 'too late', replyTo: orig.cursor });
  check('reply to a deleted message refused', r.status === 400 && /deleted/.test(r.body?.error), r);
  const idx = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': 'CHAT', ':s': `RPL#${orig.messageId}#` } }));
  check('reply index row removed with the original', (idx.Items ?? []).length === 0, idx.Items);

  r = await B.call('POST', '/api/chat/delete', { cursor: reply.cursor });
  check('B deletes the reply', r.status === 200, r);
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  const ids = new Set(posted.filter(Boolean).map((m) => m.messageId));
  const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': 'CHAT' } }));
  let n = 0;
  for (const it of items.Items ?? []) {
    if (ids.has(it.messageId) || [...ids].some((id) => String(it.SK).includes(id))) {
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CHAT', SK: it.SK } }));
      n++;
    }
  }
  for (const pid of players) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PLAYER#${pid}`, SK: 'PROFILE' } }));
  for (const e of users) await cog.send(new C.AdminDeleteUserCommand({ UserPoolId: POOL, Username: e })).catch(() => {});
  console.log(`cleanup: ${n} chat rows, ${players.length} players, ${users.length} users`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
