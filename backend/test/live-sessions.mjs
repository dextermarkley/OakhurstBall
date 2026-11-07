// Live end-to-end test of gym sessions against the deployed stack, through the
// real API (kiosk, player page, admin). Creates a throwaway Cognito admin user,
// kiosk device and players, then deletes everything it created. Sends no email.
// Refuses to run while a real session is open.
//   AWS_REGION=us-west-2 node test/live-sessions.mjs
import { randomBytes, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, GetCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

// ── refuse to interfere with a real open session ──
const ptr = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
if (ptr && !ptr.closedAt && ptr.closesAt > new Date().toISOString()) {
  console.error('A real session is open; not running.');
  process.exit(2);
}

const deviceId = `agent-sess-${hex(3)}`;
const kioskToken = randomBytes(24).toString('base64url');
const PIN = '4821';
const players = {
  p1: { id: hex(12), name: 'ZZ Test One', bal: 0 },
  p2: { id: hex(12), name: 'ZZ Test Two (blocked)', bal: -600 },
  p3: { id: hex(12), name: 'ZZ Test Three (at edge)', bal: -500 },
  p4: { id: hex(12), name: 'ZZ Test Four', bal: 0 },
  me: { id: hex(12), name: 'ZZ Test Admin', bal: 0 },
};
const email = `agent-test-${hex(4)}@oakhurst-ball.org`;
const password = `Aa1${hex(12)}`;
const ourSessions = new Set();
let sub;

const K = { 'content-type': 'application/json', 'x-kiosk-device': deviceId, 'x-kiosk-token': kioskToken };
let A = {};
const call = async (method, path, body, headers) => {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const kiosk = (path, body) => call(body ? 'POST' : 'GET', `/api/kiosk${path}`, body, K);
const api = (method, path, body) => call(method, `/api${path}`, body, A);
const kioskCheckin = (p) => kiosk('/checkin', { playerId: p.id, pin: PIN });
const balance = async (p) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${p.id}`, SK: 'PROFILE' } }))).Item?.balanceCents;

try {
  // ── fixtures ──
  const u = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: players.me.name },
    ],
  }));
  sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const auth = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  A = { 'content-type': 'application/json', authorization: `Bearer ${auth.AuthenticationResult.IdToken}` };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `KIOSK#${deviceId}`, SK: 'PROFILE', deviceId, label: 'agent session test',
    deviceSecretHash: hash(kioskToken), active: true, createdAt: new Date().toISOString(),
  } }));
  for (const [k, p] of Object.entries(players)) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `PLAYER#${p.id}`, SK: 'PROFILE', playerId: p.id, name: p.name, pinHash: hash(PIN),
      balanceCents: p.bal, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      GSI1PK: 'PLAYER', GSI1SK: p.name.toLowerCase(), ...(k === 'me' ? { cognitoSub: sub } : {}),
    } }));
  }

  // ── closed gym ──
  let r = await kioskCheckin(players.p1);
  check('closed gym: kiosk check-in refused', r.status === 200 && r.body.result === 'no_session', r.body);
  check('closed gym: no charge', (await balance(players.p1)) === 0);
  r = await kiosk('/session');
  check('closed gym: kiosk shows no session', r.status === 200 && r.body.session === null, r.body);
  r = await api('GET', '/me/session');
  check('closed gym: player page shows no session', r.status === 200 && r.body.session === null && !r.body.canCheckIn, r.body);

  // ── admin opens ──
  r = await api('POST', '/admin/sessions');
  check('admin opens a session', r.status === 201 && r.body.session?.sessionId, r);
  const sid = r.body?.session?.sessionId;
  ourSessions.add(sid);
  const hours = (new Date(r.body.session.closesAt) - new Date(r.body.session.openedAt)) / 3_600_000;
  check('session auto-closes 5 hours after opening', hours === 5, r.body.session);
  r = await api('POST', '/admin/sessions');
  check('second open refused while one is open (409)', r.status === 409, r);

  // ── kiosk check-ins ──
  r = await kioskCheckin(players.p1);
  check('p1 checks in: $5 charged', r.body.result === 'checked_in' && r.body.feeCents === 500 && r.body.balanceCents === -500, r.body);
  r = await kioskCheckin(players.p1);
  check('p1 again: already in, no second charge', r.body.result === 'already' && r.body.balanceCents === -500, r.body);
  r = await kioskCheckin(players.p2);
  check('p2 at −$6: blocked (would pass −$10)', r.body.result === 'limit' && r.body.needCents === 100, r.body);
  check('p2 blocked: balance unchanged', (await balance(players.p2)) === -600);
  r = await kioskCheckin(players.p3);
  check('p3 at −$5: allowed, lands exactly on −$10', r.body.result === 'checked_in' && r.body.balanceCents === -1000, r.body);
  r = await kioskCheckin(players.p3);
  check('p3 again: "already", not "limit"', r.body.result === 'already' && r.body.balanceCents === -1000, r.body);
  r = await kiosk('/checkin', { playerId: players.p4.id, pin: '0000' });
  check('wrong PIN still rejected', r.status === 401, r);

  // ── player page ──
  r = await api('GET', '/me/session');
  check('player page: open session, can check in', r.body.session?.sessionId === sid && r.body.canCheckIn && !r.body.checkedIn, r.body);
  r = await api('POST', '/me/checkin');
  check('player page check-in: $5 charged', r.body.result === 'checked_in' && r.body.balanceCents === -500, r.body);
  r = await api('GET', '/me/session');
  check('player page: now shows checked in', r.body.checkedIn === true && r.body.canCheckIn === false, r.body);

  // ── kiosk roster + red indicator ──
  r = await kiosk('/session');
  const names = (r.body.attendees ?? []).map((a) => a.name);
  check('kiosk roster lists the 3 checked-in players', r.body.attendees?.length === 3 && names.includes(players.me.name), names);
  check('kiosk roster flags negative balances', r.body.attendees?.every((a) => a.negative === true), r.body.attendees);
  r = await kiosk('/players');
  const p2 = r.body.players.find((p) => p.playerId === players.p2.id);
  const p4 = r.body.players.find((p) => p.playerId === players.p4.id);
  check('kiosk name list: red flag on negative, none on $0', p2?.negative === true && p4?.negative === false, { p2, p4 });
  check('kiosk name list exposes no balance amounts', r.body.players.every((p) => !('balanceCents' in p)), r.body.players[0]);

  // ── admin history ──
  await sleep(1500); // GSI is eventually consistent
  r = await api('GET', '/admin/sessions');
  const listed = r.body.sessions?.find((s) => s.sessionId === sid);
  check('admin list: session open with 3 players', listed?.open === true && listed?.attendeeCount === 3, listed);
  r = await api('GET', `/admin/sessions/${sid}`);
  check('admin detail: 3 attendees incl. one from the player page',
    r.body.attendees?.length === 3 && r.body.attendees.some((a) => a.source === 'player'), r.body.attendees);

  // ── automatic close after the time limit ──
  const past = new Date(Date.now() - 60_000).toISOString();
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { PK: `SESSION#${sid}`, SK: 'META' },
    UpdateExpression: 'SET closesAt = :p', ExpressionAttributeValues: { ':p': past } }));
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' },
    UpdateExpression: 'SET closesAt = :p', ExpressionAttributeValues: { ':p': past } }));
  r = await kiosk('/session');
  check('past its close time: kiosk shows gym closed', r.body.session === null, r.body);
  r = await kioskCheckin(players.p4);
  check('past its close time: check-in refused', r.body.result === 'no_session', r.body);
  await sleep(1500);
  r = await api('GET', '/admin/sessions');
  const auto = r.body.sessions?.find((s) => s.sessionId === sid);
  check('admin list: marked auto-closed', auto?.open === false && auto?.autoClosed === true, auto);

  // ── manual close ──
  r = await api('POST', '/admin/sessions');
  check('a new session can open after auto-close', r.status === 201, r);
  const sid2 = r.body?.session?.sessionId;
  ourSessions.add(sid2);
  r = await kioskCheckin(players.p4);
  check('p4 checks in to the new session', r.body.result === 'checked_in', r.body);
  r = await api('POST', `/admin/sessions/${sid2}/close`);
  check('admin closes the session', r.body?.result === 'closed', r.body);
  r = await kioskCheckin(players.p1);
  check('after close: check-in refused', r.body.result === 'no_session', r.body);
  r = await api('POST', `/admin/sessions/${sid2}/close`);
  check('closing twice is harmless', r.body?.result === 'already', r.body);
} catch (err) {
  failures++;
  console.error('ERROR', err);
} finally {
  // ── cleanup ──
  let n = 0;
  for (const sid of ourSessions) {
    if (!sid) continue;
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `SESSION#${sid}` } }));
    for (const it of items.Items ?? []) { await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } })); n++; }
  }
  const p = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
  if (p && ourSessions.has(p.sessionId)) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } })); n++;
  }
  const ids = Object.values(players).map((x) => x.id);
  if (sub) { // a player profile the signup trigger may have created for the test user
    const all = await ddb.send(new QueryCommand({ TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p',
      FilterExpression: 'cognitoSub = :s', ExpressionAttributeValues: { ':p': 'PLAYER', ':s': sub } }));
    for (const it of all.Items ?? []) if (!ids.includes(it.playerId)) ids.push(it.playerId);
  }
  for (const id of ids) {
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `PLAYER#${id}` } }));
    for (const it of items.Items ?? []) { await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } })); n++; }
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `KIOSK#${deviceId}`, SK: 'PROFILE' } }));
  try { await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: email })); } catch {}
  console.log(`cleanup: removed ${n} items, kiosk ${deviceId}, cognito user ${email}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
