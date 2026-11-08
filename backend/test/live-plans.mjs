// Live end-to-end test of quarter/year passes against the deployed stack, through
// the real API. Throwaway Cognito admin, kiosk, players and a cash-recipient admin
// with NO email (so no email is sent). Deletes everything it created.
// Refuses to run while a real session is open.
//   AWS_REGION=us-west-2 node test/live-plans.mjs
import { randomBytes, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand, AdminDeleteUserCommand, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const BASE = 'https://www.oakhurst-ball.org';
const TABLE = 'oakhurst';
// Fixture players have signed the current waiver + rules (see src/lib/agreements.ts).
const SIGNED = { waiverVersion: '2026-11-07', rulesVersion: '2026-11-07.2', agreedAt: '2026-11-07T00:00:00.000Z', signedName: 'ZZ Test' };
const POOL = 'us-west-2_sgaAJES20';
const CLIENT = '2fm9q7bir02ib5upgeeelivdii';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const hex = (n) => randomBytes(n).toString('hex');
const hash = (s) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(s, salt, 32, { N: 16384 }).toString('hex')}`;
};

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

const ptr = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
if (ptr && !ptr.closedAt && ptr.closesAt > new Date().toISOString()) {
  console.error('A real session is open; not running.');
  process.exit(2);
}

const deviceId = `agent-plan-${hex(3)}`;
const kioskToken = randomBytes(24).toString('base64url');
const cashAdminId = hex(12);
const PIN = '4821';
const P = {
  a: { id: hex(12), name: 'ZZ Plan A (deep negative)', bal: -1500 },
  b: { id: hex(12), name: 'ZZ Plan B (pays then upgrades)', bal: 0 },
  c: { id: hex(12), name: 'ZZ Plan C (cash quarter)', bal: 0 },
  d: { id: hex(12), name: 'ZZ Plan D (double purchase)', bal: 0 },
  me: { id: hex(12), name: 'ZZ Plan Admin', bal: 0 },
};
const email = `agent-plan-${hex(4)}@oakhurst-ball.org`;
const password = `Aa1${hex(12)}`;
const sessions = new Set();
let sub;
let A = {};

const K = { 'content-type': 'application/json', 'x-kiosk-device': deviceId, 'x-kiosk-token': kioskToken };
const call = async (method, path, body, headers) => {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const kiosk = (path, body) => call(body ? 'POST' : 'GET', `/api/kiosk${path}`, body, K);
const api = (method, path, body) => call(method, `/api${path}`, body, A);
// 'defer' = check in now; pass holders are covered either way.
const checkin = (p) => kiosk('/checkin', { playerId: p.id, pin: PIN, mode: 'defer' });
const balance = async (p) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${p.id}`, SK: 'PROFILE' } }))).Item?.balanceCents;
const passesOf = async (p) =>
  (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':pk': `PLAYER#${p.id}`, ':s': 'PASS#' } }))).Items ?? [];

try {
  // ── fixtures ──
  const u = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: P.me.name }],
  }));
  sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const auth = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  A = { 'content-type': 'application/json', authorization: `Bearer ${auth.AuthenticationResult.IdToken}` };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `KIOSK#${deviceId}`, SK: 'PROFILE', deviceId, label: 'agent plan test',
    deviceSecretHash: hash(kioskToken), active: true, createdAt: new Date().toISOString(),
  } }));
  // Cash-recipient admin with no email → no confirmation email is sent.
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `ADMIN#${cashAdminId}`, SK: 'PROFILE', adminId: cashAdminId, name: 'ZZ Test Cashier', active: true,
    createdAt: new Date().toISOString(),
  } }));
  for (const [k, p] of Object.entries(P)) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `PLAYER#${p.id}`, SK: 'PROFILE', playerId: p.id, name: p.name, pinHash: hash(PIN),
      balanceCents: p.bal, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      GSI1PK: 'PLAYER', ...SIGNED, GSI1SK: p.name.toLowerCase(), ...(k === 'me' ? { cognitoSub: sub } : {}),
    } }));
  }

  // ── offers: today is in Q3 2026–27 (Oct 1 – Dec 31) ──
  let r = await api('GET', '/me/session');
  const q = r.body.options?.plans?.find((o) => o.plan === 'quarter');
  const y = r.body.options?.plans?.find((o) => o.plan === 'year');
  check('player page offers $80 quarter for the current quarter',
    q?.priceCents === 8000 && q?.label === 'Q3 2026–27 (Oct 1 – Dec 31)' && q?.end === '2026-12-31' && q?.available, q);
  check('year pass not offered after Q1 (today is Q3)', y?.status === 'not_offered' && y?.available === false, y);
  r = await api('POST', '/me/pay-card', { plan: 'year' });
  check('player page refuses a year pass after Q1 (409)', r.status === 409, r);

  r = await api('POST', '/admin/sessions');
  check('admin opens a session', r.status === 201, r);
  sessions.add(r.body?.session?.sessionId);

  // ── A: deep negative, blocked; quarter pass recorded by admin → free entry ──
  r = await checkin(P.a);
  check('A at −$15 is blocked before the pass', r.body.result === 'limit', r.body);
  r = await api('POST', `/admin/players/${P.a.id}/pass`, { plan: 'quarter' });
  check('admin records a quarter pass for A', r.status === 201 && r.body.pass?.plan === 'quarter', r);
  r = await checkin(P.a);
  check('A with a pass checks in despite −$15 (limit waived)', r.body.result === 'checked_in' && r.body.pass?.plan === 'quarter', r.body);
  check('A is charged nothing', r.body.feeCents === 0 && (await balance(P.a)) === -1500, r.body);
  r = await api('POST', `/admin/players/${P.a.id}/pass`, { plan: 'quarter' });
  check('a second quarter pass for A is refused (409)', r.status === 409, r);

  // ── B: pays $5, then a year pass refunds today's fee ──
  r = await checkin(P.b);
  check('B checks in pay-as-you-go: $5', r.body.result === 'checked_in' && r.body.feeCents === 500 && r.body.balanceCents === -500, r.body);
  r = await api('POST', `/admin/players/${P.b.id}/pass`, { plan: 'year' });
  check('admin can still record a year pass after Q1; refunds today’s $5', r.status === 201 && r.body.refundedCents === 500, r.body);
  check('B balance back to $0', (await balance(P.b)) === 0);
  r = await api('POST', `/admin/players/${P.b.id}/pass`, { plan: 'quarter' });
  check('quarter pass on top of a year pass is refused', r.status === 409, r);
  r = await kiosk('/pay', { playerId: P.b.id, pin: PIN, method: 'cash', adminId: cashAdminId, plan: 'quarter' });
  check('kiosk refuses selling B a quarter pass too', r.status === 409, r);

  // ── C: buys a quarter pass with cash at the kiosk; admin confirms ──
  r = await kiosk('/pay', { playerId: P.c.id, pin: PIN, method: 'cash', adminId: cashAdminId, plan: 'quarter' });
  check('kiosk cash quarter pass: $80 pending', r.status === 201 && r.body.amountCents === 8000 && r.body.emailed === false, r.body);
  const cPay = r.body.paymentId;
  r = await api('GET', '/admin/pending');
  const pend = r.body.pending?.find((x) => x.paymentId === cPay);
  check('Admin pending list shows it as a quarter pass', pend?.plan === 'quarter' && pend?.periodLabel?.startsWith('Q3'), pend);
  r = await api('POST', `/admin/payments/${cPay}/confirm`);
  check('admin confirms the cash', r.body?.result === 'confirmed', r.body);
  const cPasses = await passesOf(P.c);
  check('C now holds the Q3 pass', cPasses.length === 1 && cPasses[0].periodId === 'Q2026-3' && cPasses[0].source === 'cash', cPasses);
  check('C balance unchanged (money bought the pass, not credit)', (await balance(P.c)) === 0);
  r = await checkin(P.c);
  check('C checks in free', r.body.result === 'checked_in' && r.body.feeCents === 0, r.body);
  r = await kiosk(`/payments/${cPay}`);
  check('kiosk payment poll reports the plan', r.body.status === 'confirmed' && r.body.plan === 'quarter', r.body);

  // ── D: two quarter purchases both confirmed → second becomes credit ──
  const d1 = (await kiosk('/pay', { playerId: P.d.id, pin: PIN, method: 'cash', adminId: cashAdminId, plan: 'quarter' })).body.paymentId;
  const d2 = (await kiosk('/pay', { playerId: P.d.id, pin: PIN, method: 'cash', adminId: cashAdminId, plan: 'quarter' })).body.paymentId;
  await api('POST', `/admin/payments/${d1}/confirm`);
  await api('POST', `/admin/payments/${d2}/confirm`);
  check('D holds exactly one quarter pass', (await passesOf(P.d)).length === 1);
  check('D’s duplicate $80 became account credit', (await balance(P.d)) === 8000, await balance(P.d));

  // ── card path and admin views ──
  r = await api('POST', '/me/pay-card', { plan: 'quarter' });
  check('card quarter pass → $80 Stripe checkout', r.status === 201 && r.body.amountCents === 8000 && /checkout\.stripe\.com/.test(r.body.checkoutUrl ?? ''), r);
  r = await kiosk('/pay', { playerId: P.d.id, pin: PIN, method: 'cash', adminId: cashAdminId, plan: 'year' });
  check('kiosk refuses a year pass after Q1 (409)', r.status === 409, r);
  r = await api('POST', '/me/pay-card', { plan: 'monthly' });
  check('unknown plan rejected', r.status === 400, r);
  await new Promise((s) => setTimeout(s, 1200)); // GSI is eventually consistent
  r = await api('GET', '/admin/players');
  const row = (id) => r.body.players?.find((p) => p.playerId === id);
  check('Admin players list shows each pass', row(P.a.id)?.pass?.plan === 'quarter' && row(P.b.id)?.pass?.plan === 'year' && row(P.me.id)?.pass === null,
    { a: row(P.a.id)?.pass, b: row(P.b.id)?.pass, me: row(P.me.id)?.pass });
  const sid = [...sessions][0];
  r = await api('GET', `/admin/sessions/${sid}`);
  const att = Object.fromEntries((r.body.attendees ?? []).map((x) => [x.playerId, x]));
  check('session attendees record which pass covered them',
    att[P.a.id]?.coveredBy === 'quarter' && att[P.b.id]?.coveredBy === 'year' && att[P.b.id]?.feeCents === 0, att);

  r = await api('POST', `/admin/sessions/${sid}/close`);
  check('admin closes the session', r.body?.result === 'closed', r.body);
} catch (err) {
  failures++;
  console.error('ERROR', err);
} finally {
  let n = 0;
  const del = async (Key) => { await ddb.send(new DeleteCommand({ TableName: TABLE, Key })); n++; };
  for (const sid of sessions) {
    if (!sid) continue;
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `SESSION#${sid}` } }));
    for (const it of items.Items ?? []) await del({ PK: it.PK, SK: it.SK });
  }
  const p = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
  if (p && sessions.has(p.sessionId)) await del({ PK: 'CURRENT', SK: 'SESSION' });
  const ids = Object.values(P).map((x) => x.id);
  if (sub) {
    const all = await ddb.send(new QueryCommand({ TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p',
      FilterExpression: 'cognitoSub = :s', ExpressionAttributeValues: { ':p': 'PLAYER', ':s': sub } }));
    for (const it of all.Items ?? []) if (!ids.includes(it.playerId)) ids.push(it.playerId);
  }
  for (const id of ids) {
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `PLAYER#${id}` } }));
    for (const it of items.Items ?? []) {
      if (it.SK.startsWith('PAYMENT#')) {
        await del({ PK: `PAYREF#${it.paymentId}`, SK: 'REF' });
        if (it.confirmToken) await del({ PK: `TOKEN#${it.confirmToken}`, SK: 'TOKEN' });
        if (it.confirmTokenHash) await del({ PK: `TOKENH#${it.confirmTokenHash}`, SK: 'TOKEN' });
      }
      await del({ PK: it.PK, SK: it.SK });
    }
  }
  await del({ PK: `KIOSK#${deviceId}`, SK: 'PROFILE' });
  await del({ PK: `ADMIN#${cashAdminId}`, SK: 'PROFILE' });
  try { await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: email })); } catch {}
  console.log(`cleanup: removed ${n} items + cognito user ${email}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
