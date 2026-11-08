// Live security checks against the deployed site. Creates throwaway kiosks, a
// throwaway admin record (no email, so nothing is sent), a throwaway Cognito user
// + player, and removes all of it at the end. Touches no real data.
//   AWS_REGION=us-west-2 node test/live-security.mjs
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import * as C from '@aws-sdk/client-cognito-identity-provider';

const BASE = 'https://oakhurst-ball.org';
const TABLE = 'oakhurst';
const POOL = 'us-west-2_sgaAJES20';
const CLIENT = '2fm9q7bir02ib5upgeeelivdii';
const SIGNED = { waiverVersion: '2026-11-07', rulesVersion: '2026-11-07.2', agreedAt: '2026-11-07T00:00:00.000Z', signedName: 'ZZ Test' };
const region = process.env.AWS_REGION ?? 'us-west-2';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const cog = new C.CognitoIdentityProviderClient({ region });
const hex = (n) => randomBytes(n).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const scrypt = (s) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(s, salt, 32, { N: 16384 }).toString('hex')}`;
};
const now = () => new Date().toISOString();

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || extra === undefined ? '' : '  ' + JSON.stringify(extra)}`);
  if (!cond) failed++;
};

// ── Fixtures ──
const kNew = { id: `agent-sec-${hex(3)}`, token: randomBytes(24).toString('base64url') };
const kOld = { id: `agent-sec-${hex(3)}`, token: randomBytes(24).toString('base64url') };
const playerA = hex(12); // kiosk player for PIN + cash tests
const playerB = hex(12); // second kiosk player for the lockout test
const adminId = hex(12);
const PIN = '4821';
const user = { email: `agent-sec-${hex(4)}@oakhurst-ball.org`, password: `Aa1${hex(8)}`, playerId: hex(12) };
const extraKeys = []; // other rows to delete at the end

async function put(Item) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item }));
}
async function setup() {
  await put({ PK: `KIOSK#${kNew.id}`, SK: 'PROFILE', deviceId: kNew.id, label: 'agent sec', active: true,
    deviceSecretHash: 'sha256:' + sha(kNew.token), createdAt: now() });
  await put({ PK: `KIOSK#${kOld.id}`, SK: 'PROFILE', deviceId: kOld.id, label: 'agent sec old', active: true,
    deviceSecretHash: scrypt(kOld.token), createdAt: now() });
  for (const [pid, name] of [[playerA, 'ZZ Sec A (delete me)'], [playerB, 'ZZ Sec B (delete me)']]) {
    await put({ PK: `PLAYER#${pid}`, SK: 'PROFILE', playerId: pid, name, pinHash: scrypt(PIN), balanceCents: 0,
      active: true, approved: true, createdAt: now(), updatedAt: now(), GSI1PK: 'PLAYER', GSI1SK: 'zz sec', ...SIGNED });
  }
  // Admin with no email and no account: cash to them sends no email and no push.
  await put({ PK: `ADMIN#${adminId}`, SK: 'PROFILE', adminId, name: 'ZZ Sec Admin', active: true, createdAt: now(),
    GSI1PK: 'ADMIN_TEST', GSI1SK: 'zz' }); // not in the real admin list
  const u = await cog.send(new C.AdminCreateUserCommand({ UserPoolId: POOL, Username: user.email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: user.email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: 'ZZ Sec User' }] }));
  user.sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cog.send(new C.AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: user.email, Password: user.password, Permanent: true }));
  await put({ PK: `PLAYER#${user.playerId}`, SK: 'PROFILE', playerId: user.playerId, name: 'ZZ Sec User', email: user.email,
    cognitoSub: user.sub, balanceCents: 0, active: true, approved: true, createdAt: now(), updatedAt: now(),
    GSI1PK: 'PLAYER', GSI1SK: 'zz sec user', ...SIGNED });
}

async function cleanup() {
  for (const pid of [playerA, playerB, user.playerId]) {
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `PLAYER#${pid}` } }));
    for (const it of items.Items ?? []) {
      if (it.paymentId) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PAYREF#${it.paymentId}`, SK: 'REF' } }));
      if (it.confirmTokenHash) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `TOKENH#${it.confirmTokenHash}`, SK: 'TOKEN' } }));
      if (it.confirmToken) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `TOKEN#${it.confirmToken}`, SK: 'TOKEN' } }));
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
    }
  }
  for (const Key of [
    { PK: `KIOSK#${kNew.id}`, SK: 'PROFILE' },
    { PK: `KIOSK#${kOld.id}`, SK: 'PROFILE' },
    { PK: `ADMIN#${adminId}`, SK: 'PROFILE' },
    ...extraKeys,
  ]) await ddb.send(new DeleteCommand({ TableName: TABLE, Key }));
  await cog.send(new C.AdminDeleteUserCommand({ UserPoolId: POOL, Username: user.email })).catch(() => {});
  console.log('cleanup done');
}

const kioskReq = async (k, method, path, body) => {
  const r = await fetch(BASE + '/api/kiosk' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-kiosk-device': k.id, 'x-kiosk-token': k.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function idToken() {
  const r = await cog.send(new C.InitiateAuthCommand({ ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: user.email, PASSWORD: user.password } }));
  return r.AuthenticationResult.IdToken;
}
const apiReq = async (tok, method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, text: await r.text() };
};

try {
  await setup();

  // ── Kiosk device auth ──
  check('kiosk with SHA-256 token works', (await kioskReq(kNew, 'GET', '/admins')).status === 200);
  const old1 = await kioskReq(kOld, 'GET', '/admins');
  check('kiosk paired before the change (scrypt) still works', old1.status === 200, old1);
  const upgraded = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `KIOSK#${kOld.id}`, SK: 'PROFILE' } }));
  check('old kiosk hash upgraded to SHA-256', String(upgraded.Item?.deviceSecretHash).startsWith('sha256:'));
  check('old kiosk still works after upgrade', (await kioskReq(kOld, 'GET', '/admins')).status === 200);
  const unknown = await kioskReq({ id: `nope-${hex(4)}`, token: kNew.token }, 'GET', '/admins');
  const wrong = await kioskReq({ id: kNew.id, token: randomBytes(24).toString('base64url') }, 'GET', '/admins');
  check('unknown kiosk and wrong token give the same answer', unknown.status === 401 && wrong.status === 401 &&
    unknown.body?.error === 'bad kiosk token' && wrong.body?.error === 'bad kiosk token', { unknown, wrong });

  // ── PIN lockout (player B) ──
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await kioskReq(kNew, 'POST', '/checkin', { playerId: playerB, pin: '0000' })).body?.error);
  check('5 wrong PINs each say wrong PIN', codes.every((c) => c === 'wrong PIN'), codes);
  const locked = await kioskReq(kNew, 'POST', '/checkin', { playerId: playerB, pin: PIN });
  check('6th try is locked even with the right PIN (429)', locked.status === 429 && /Too many wrong PINs/.test(locked.body?.error), locked);
  const huge = await kioskReq(kNew, 'POST', '/checkin', { playerId: playerA, pin: '1'.repeat(100000) });
  check('oversized PIN rejected as wrong PIN', huge.status === 401 && huge.body?.error === 'wrong PIN', huge);
  const arr = await kioskReq(kNew, 'POST', '/checkin', { playerId: [playerA], pin: PIN });
  check('non-string playerId rejected (400)', arr.status === 400, arr);

  // ── Cash: pending cap, no token stored ──
  const pays = [];
  for (let i = 0; i < 4; i++) {
    pays.push(await kioskReq(kNew, 'POST', '/pay', { playerId: playerA, pin: PIN, method: 'cash', adminId, amountCents: 500 }));
  }
  check('first 3 cash payments accepted', pays.slice(0, 3).every((p) => p.status === 201), pays.map((p) => p.status));
  check('4th pending cash payment refused (409)', pays[3].status === 409, pays[3]);
  const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':pk': `PLAYER#${playerA}`, ':s': 'PAYMENT#' } }));
  const p0 = items.Items?.[0] ?? {};
  check('payment row stores no confirm token', !('confirmToken' in p0) && /^[a-f0-9]{64}$/.test(p0.confirmTokenHash ?? ''), p0);
  const trow = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `TOKENH#${p0.confirmTokenHash}`, SK: 'TOKEN' } }));
  check('token row keyed by hash', trow.Item?.paymentId === p0.paymentId);

  // ── Confirm links: expiry enforced, legacy links still work ──
  const expiredTok = randomBytes(24).toString('base64url');
  const legacyTok = randomBytes(24).toString('base64url');
  const kExp = { PK: `TOKENH#${sha(expiredTok)}`, SK: 'TOKEN' };
  const kLeg = { PK: `TOKEN#${legacyTok}`, SK: 'TOKEN' };
  extraKeys.push(kExp, kLeg);
  const ref = { playerId: playerA, paymentId: p0.paymentId, paymentSortKey: p0.SK };
  await put({ ...kExp, ...ref, expiresAt: Math.floor(Date.now() / 1000) - 60 });
  await put({ ...kLeg, ...ref, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  check('expired confirm link refused (404)', (await fetch(`${BASE}/api/confirm/${expiredTok}`)).status === 404);
  check('legacy (raw-token) confirm link still opens', (await fetch(`${BASE}/api/confirm/${legacyTok}`)).status === 200);
  check('malformed confirm token is a 400, not a 500', (await fetch(`${BASE}/api/confirm/%E0%A4%A`)).status === 400);
  // End to end with a hashed-key link: confirm pays out once and the row is gone.
  const p1 = items.Items[1];
  const linkTok = randomBytes(24).toString('base64url');
  const kLink = { PK: `TOKENH#${sha(linkTok)}`, SK: 'TOKEN' };
  extraKeys.push(kLink);
  await put({ ...kLink, playerId: playerA, paymentId: p1.paymentId, paymentSortKey: p1.SK, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const before = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${playerA}`, SK: 'PROFILE' } }))).Item.balanceCents;
  const conf = await fetch(`${BASE}/api/confirm/${linkTok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"confirm"}' });
  const confBody = await conf.json();
  const after = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${playerA}`, SK: 'PROFILE' } }))).Item.balanceCents;
  const gone = !(await ddb.send(new GetCommand({ TableName: TABLE, Key: kLink }))).Item;
  check('confirm-link confirm credits once and uses up the link', confBody.result === 'confirmed' && after - before === p1.amountCents && gone, { confBody, before, after, gone });
  const settled = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${playerA}`, SK: p1.SK } }))).Item;
  check('settled payment records who settled it', settled?.settledBy === 'link', settled?.settledBy);

  // ── Signed-in player ──
  let tok = await idToken();
  const pc = await apiReq(tok, 'POST', '/api/me/pay-cash', { adminId, amountCents: 1000 });
  check('player cash payment accepted', pc.status === 201, pc);
  const bal = await apiReq(tok, 'GET', '/api/me/balance');
  check('balance payload has no token, hash, keys or checkout URL',
    bal.status === 200 && !/confirmToken|TokenHash|"PK"|"SK"|GSI1|checkoutUrl/.test(bal.text), bal.text.slice(0, 300));
  // Self-pay: make the test admin record the same person as this user.
  await put({ PK: `ADMIN#${adminId}`, SK: 'PROFILE', adminId, name: 'ZZ Sec Admin', active: true, createdAt: now(),
    cognitoSub: user.sub, GSI1PK: 'ADMIN_TEST', GSI1SK: 'zz' });
  const self = await apiReq(tok, 'POST', '/api/me/pay-cash', { adminId, amountCents: 500 });
  check('cash to yourself refused (409)', self.status === 409 && /your own cash/.test(self.text), self);

  // Admin confirming their own payment: put the user in the admin group briefly.
  await cog.send(new C.AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: user.email, GroupName: 'admin' }));
  try {
    tok = await idToken();
    const mine = JSON.parse(pc.text).paymentId;
    const sc = await apiReq(tok, 'POST', `/api/admin/payments/${mine}/confirm`, {});
    check('admin can’t confirm their own cash (403)', sc.status === 403, sc);
    const ghost = await apiReq(tok, 'POST', `/api/admin/players/${hex(12)}/credit`, { amountCents: 500 });
    check('credit to a missing player is 404 (no phantom row)', ghost.status === 404, ghost);
    const big = await apiReq(tok, 'POST', `/api/admin/players/${user.playerId}/credit`, { amountCents: 100_001 });
    check('credit over $1,000 refused', big.status === 400, big);
    const okc = await apiReq(tok, 'POST', `/api/admin/players/${user.playerId}/charge`, { amountCents: 500, note: 'test\u202e charge' });
    const audit = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':pk': `PLAYER#${user.playerId}`, ':s': 'ADJUST#' } }));
    const a0 = audit.Items?.[0];
    check('charge works and writes an audit row', okc.status === 200 && a0?.deltaCents === -500 && a0?.bySub === user.sub && a0?.note === 'test charge', { okc, a0 });
    const badName = await apiReq(tok, 'POST', '/api/admin/players', { name: { x: 1 } });
    check('admin create-player rejects a non-string name', badName.status === 400, badName);
  } finally {
    await cog.send(new C.AdminRemoveUserFromGroupCommand({ UserPoolId: POOL, Username: user.email, GroupName: 'admin' }));
  }
  const notJson = await fetch(BASE + '/api/me/pin', { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: '{not json' });
  check('invalid JSON body is a 400, not a 500', notJson.status === 400, notJson.status);

  // ── Web headers ──
  const home = await fetch(BASE + '/');
  const csp = home.headers.get('content-security-policy') ?? '';
  check('CSP on the page, framing denied', /script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), csp);
  check('Permissions-Policy present', /camera=\(self\)/.test(home.headers.get('permissions-policy') ?? ''));
  const bad = await fetch(BASE + '/%E0%A4%A.js');
  check('malformed URL is refused, not a 500', bad.status === 400 || bad.status === 404, bad.status);
  const missing = await fetch(BASE + `/nope-${hex(3)}.js`);
  check('missing file is a 404 with security headers', missing.status === 404 && !!missing.headers.get('content-security-policy'), missing.status);
  const api = await fetch(BASE + '/api/me');
  check('API CORS limited to the site origin', (await fetch(BASE + '/api/kiosk/admins')).headers.get('access-control-allow-origin') === BASE, api.status);
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await cleanup();
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
