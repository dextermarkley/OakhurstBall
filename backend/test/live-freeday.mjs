// Live test of free days. Opens a throwaway session straight in the table (opening
// through the API would notify everyone), restores the real session pointer after.
// Refuses to run while a real session is open. Deletes everything it made.
//   AWS_REGION=us-west-2 node test/live-freeday.mjs
import { randomBytes, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand, AdminDeleteUserCommand, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const BASE = 'https://www.oakhurst-ball.org';
const TABLE = 'oakhurst';
const POOL = 'us-west-2_sgaAJES20';
const CLIENT = '2fm9q7bir02ib5upgeeelivdii';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const hex = (n) => randomBytes(n).toString('hex');
const hash = (s) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(s, salt, 32, { N: 16384 }).toString('hex')}`;
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (!cond) failures++;
};

const oldPtr = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
if (oldPtr && !oldPtr.closedAt && oldPtr.closesAt > new Date().toISOString()) {
  console.error('A real session is open; not running.');
  process.exit(2);
}

const PIN = '4821';
const deviceId = `agent-free-${hex(3)}`;
const kioskToken = randomBytes(24).toString('base64url');
const sessionId = hex(12);
const P = {
  a: { id: hex(12), name: 'ZZ Free A (paid before)', bal: 0 },
  b: { id: hex(12), name: 'ZZ Free B (at the limit)', bal: -1000 },
  c: { id: hex(12), name: 'ZZ Free C (during free)', bal: 0 },
  d: { id: hex(12), name: 'ZZ Free D (after free)', bal: 0 },
  me: { id: hex(12), name: 'ZZ Free Admin', bal: -1000 },
};
const email = `agent-free-${hex(4)}@oakhurst-ball.org`;
const password = `Aa1${hex(12)}`;
let A = {};
const K = { 'content-type': 'application/json', 'x-kiosk-device': deviceId, 'x-kiosk-token': kioskToken };
const call = async (method, path, body, headers) => {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const kioskIn = (p, mode = 'auto') => call('POST', '/api/kiosk/checkin', { playerId: p.id, pin: PIN, mode }, K);
const balance = async (p) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${p.id}`, SK: 'PROFILE' } }))).Item?.balanceCents;

try {
  const u = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: P.me.name }],
  }));
  const sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const auth = await cognito.send(new InitiateAuthCommand({ ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }));
  A = { 'content-type': 'application/json', authorization: `Bearer ${auth.AuthenticationResult.IdToken}` };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: `KIOSK#${deviceId}`, SK: 'PROFILE', deviceId, label: 'agent free test', deviceSecretHash: hash(kioskToken), active: true, createdAt: new Date().toISOString() } }));
  for (const [k, p] of Object.entries(P)) {
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `PLAYER#${p.id}`, SK: 'PROFILE', playerId: p.id, name: p.name, pinHash: hash(PIN), balanceCents: p.bal, active: true,
      createdAt: now, updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: p.name.toLowerCase(), ...(k === 'me' ? { cognitoSub: sub } : {}),
    } }));
  }
  // A normal (paid) session, written directly.
  const openedAt = new Date().toISOString();
  const closesAt = new Date(Date.now() + 3600_000).toISOString();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: `SESSION#${sessionId}`, SK: 'META', sessionId, eventDate: today, openedAt, closesAt, openedByName: 'ZZ Free Admin', attendeeCount: 0, GSI1PK: 'SESSION', GSI1SK: openedAt } }));
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: 'CURRENT', SK: 'SESSION', sessionId, closesAt } }));

  let r = await kioskIn(P.a, 'defer');
  check('normal session: A pays $5', r.body?.result === 'checked_in' && r.body.feeCents === 500 && (await balance(P.a)) === -500, r.body);
  r = await kioskIn(P.b);
  check('normal session: B at −$10 is blocked', r.body?.result === 'limit', r.body);
  r = await call('GET', '/api/me/session', null, A);
  check('player page: not free yet', r.body?.payState === 'blocked' && r.body.feeCents === 500, r.body?.payState);

  r = await call('POST', `/api/admin/sessions/${sessionId}/free`, { free: 'yes' }, A);
  check('bad free value rejected', r.status === 400, r);
  r = await call('POST', `/api/admin/sessions/${sessionId}/free`, { free: true }, A);
  check('admin makes it a free day; A refunded', r.status === 200 && r.body.session?.free === true && r.body.refunded === 1 && r.body.refundedCents === 500, r.body);
  check('A back to $0', (await balance(P.a)) === 0, await balance(P.a));
  const aHist = (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)', ExpressionAttributeValues: { ':pk': `PLAYER#${P.a.id}`, ':s': 'CHECKIN#' } }))).Items ?? [];
  check("A's history shows the check-in as free", aHist.length === 1 && aHist[0].feeCents === 0 && aHist[0].freeDay === true, aHist);
  r = await call('POST', `/api/admin/sessions/${sessionId}/free`, { free: true }, A);
  check('turning it on again refunds nobody twice', r.body?.refunded === 0 && (await balance(P.a)) === 0, r.body);

  r = await kioskIn(P.b);
  check('free day: B at −$10 checks in, balance untouched', r.body?.result === 'checked_in' && r.body.feeCents === 0 && r.body.freeDay === true && (await balance(P.b)) === -1000, r.body);
  r = await kioskIn(P.c);
  check('free day: C checks in for $0', r.body?.result === 'checked_in' && r.body.feeCents === 0 && (await balance(P.c)) === 0, r.body);
  r = await call('GET', '/api/me/session', null, A);
  check('player page: payState free, fee $0, can check in at −$10', r.body?.payState === 'free' && r.body.feeCents === 0 && r.body.canCheckIn === true && r.body.session?.free === true, r.body);
  r = await call('POST', '/api/me/checkin', { mode: 'auto' }, A);
  check('player page check-in is free', r.body?.result === 'checked_in' && r.body.freeDay === true && (await balance(P.me)) === -1000, r.body);
  r = await call('GET', '/api/kiosk/session', null, K);
  check('kiosk sees the free day', r.body?.session?.free === true, r.body?.session);
  r = await call('GET', `/api/admin/sessions/${sessionId}`, null, A);
  check('attendee list marks free check-ins', r.body?.attendees?.filter((x) => x.freeDay).length === 4, r.body?.attendees);

  r = await call('POST', `/api/admin/sessions/${sessionId}/free`, { free: false }, A);
  check('admin ends the free day', r.status === 200 && !r.body.session?.free, r.body);
  r = await kioskIn(P.d, 'defer');
  check('after: D pays the usual $5', r.body?.result === 'checked_in' && r.body.feeCents === 500 && (await balance(P.d)) === -500, r.body);
  check('earlier free check-ins stay free', (await balance(P.a)) === 0 && (await balance(P.c)) === 0 && (await balance(P.b)) === -1000, [await balance(P.a), await balance(P.b), await balance(P.c)]);

  r = await call('POST', `/api/admin/sessions/${sessionId}/close`, null, A);
  r = await call('POST', `/api/admin/sessions/${sessionId}/free`, { free: true }, A);
  check('closed session can’t be changed', r.status === 409, r);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  const sess = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}` } }));
  for (const it of sess.Items ?? []) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  for (const p of Object.values(P)) {
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PLAYER#${p.id}` } }));
    for (const it of items.Items ?? []) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `KIOSK#${deviceId}`, SK: 'PROFILE' } }));
  const ptr = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
  if (ptr?.sessionId === sessionId) {
    if (oldPtr) await ddb.send(new PutCommand({ TableName: TABLE, Item: oldPtr }));
    else await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }));
  }
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: email })).catch(() => {});
  console.log(`cleanup: session, ${Object.keys(P).length} players, kiosk, user; pointer ${oldPtr ? 'restored' : 'removed'}`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
