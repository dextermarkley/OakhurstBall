// Live test: a player who never signed the waiver can't check in at the kiosk
// (or on the player page) until they sign, and can sign right on the kiosk.
// Refuses to run while a real session is open (the final check-in would join it).
//   AWS_REGION=us-west-2 node test/live-kiosk-agreement.mjs
import { randomBytes, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminDeleteUserCommand, InitiateAuthCommand,
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

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (!cond) failures++;
};

const ptr = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
if (ptr && !ptr.closedAt && ptr.closesAt > new Date().toISOString()) {
  console.error('A real session is open; not running.');
  process.exit(2);
}

const PIN = '4821';
const deviceId = `agent-agree-${hex(3)}`;
const kioskToken = randomBytes(24).toString('base64url');
const kioskPlayer = hex(12);
const appPlayer = hex(12);
const email = `agent-agree-${hex(4)}@oakhurst-ball.org`;
const password = `Aa1${hex(12)}`;
const K = { 'content-type': 'application/json', 'x-kiosk-device': deviceId, 'x-kiosk-token': kioskToken };
const call = async (method, path, body, headers) => {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

try {
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: `KIOSK#${deviceId}`, SK: 'PROFILE', deviceId, label: 'agent agreement test', deviceSecretHash: hash(kioskToken), active: true, createdAt: now } }));
  // Added by an admin for the kiosk: no account, never signed.
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PLAYER#${kioskPlayer}`, SK: 'PROFILE', playerId: kioskPlayer, name: 'ZZ Agree Kiosk', pinHash: hash(PIN), balanceCents: 0,
    active: true, approved: true, createdAt: now, updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: 'zz agree kiosk',
  } }));

  let r = await call('GET', '/api/kiosk/agreements', null, K);
  const docs = r.body;
  check('kiosk serves the waiver + rules', r.status === 200 && docs.waiver?.sections?.length >= 8 && docs.rules?.sections?.length >= 5, r.status);
  r = await call('GET', '/api/kiosk/agreements', null, { 'content-type': 'application/json' });
  check('…only to a paired kiosk', r.status === 401, r.status);

  r = await call('POST', '/api/kiosk/checkin', { playerId: kioskPlayer, pin: PIN }, K);
  check('unsigned player: check-in stops with needs_agreement', r.body?.result === 'needs_agreement' && r.body.signedBefore === false, r.body);
  r = await call('POST', '/api/kiosk/checkin', { playerId: kioskPlayer, pin: PIN, mode: 'defer' }, K);
  check('…in "pay next time" mode too', r.body?.result === 'needs_agreement', r.body);
  r = await call('POST', '/api/kiosk/checkin', { playerId: kioskPlayer, pin: '0000' }, K);
  check('wrong PIN is still a wrong PIN (no waiver info leaked)', r.status === 401, r.status);

  const sig = { playerId: kioskPlayer, pin: PIN, waiverVersion: docs.waiver.version, rulesVersion: docs.rules.version, agreeRules: true, agreeWaiver: true, signedName: 'ZZ Agree Kiosk', adult: true };
  r = await call('POST', '/api/kiosk/agreements', { ...sig, pin: '0000' }, K);
  check('signing needs the right PIN', r.status === 401, r.status);
  r = await call('POST', '/api/kiosk/agreements', { ...sig, signedName: 'Zed' }, K);
  check('signing needs a full name', r.status === 400, r);
  r = await call('POST', '/api/kiosk/agreements', sig, K);
  check('player signs on the kiosk', r.status === 200 && r.body.current === true, r);

  const recs = (await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)', ExpressionAttributeValues: { ':pk': `PLAYER#${kioskPlayer}`, ':s': 'AGREEMENT#' } }))).Items ?? [];
  check('signature records say which kiosk', recs.length === 2 && recs.every((x) => x.sub === `kiosk:${deviceId}` && x.signedName === 'ZZ Agree Kiosk'), recs.map((x) => x.sub));

  r = await call('POST', '/api/kiosk/checkin', { playerId: kioskPlayer, pin: PIN }, K);
  check('after signing, check-in proceeds (no session open → no_session)', r.body?.result === 'no_session', r.body);

  // Player page: an account that hasn't signed is refused too.
  const u = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: 'ZZ Agree App' }],
  }));
  const sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PLAYER#${appPlayer}`, SK: 'PROFILE', playerId: appPlayer, name: 'ZZ Agree App', balanceCents: 0, active: true,
    createdAt: now, updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: 'zz agree app', cognitoSub: sub, email,
  } }));
  const a = await cognito.send(new InitiateAuthCommand({ ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }));
  const A = { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
  r = await call('POST', '/api/me/checkin', { mode: 'auto' }, A);
  check('player page check-in also requires signing', r.body?.result === 'needs_agreement', r.body);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  for (const pid of [kioskPlayer, appPlayer]) {
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PLAYER#${pid}` } }));
    for (const it of items.Items ?? []) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `KIOSK#${deviceId}`, SK: 'PROFILE' } }));
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: email })).catch(() => {});
  console.log('cleanup: 2 players, kiosk, user');
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
