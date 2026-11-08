// Live test of chat approval + the "new sign-up" admin notification.
//  - throwaway admin + unapproved player: chat is 403 until approved, works after,
//    403 again when access is removed; players can't approve; admin-added players
//    start approved
//  - the sign-up trigger Lambda is invoked with a sign-up event (no Cognito email
//    is sent). Two fake push devices are registered, one admin and one player; the
//    push service rejects fake devices, and the app deletes a device it pushed to
//    and got rejected by. So: admin device gone = admin was notified, player device
//    still there = the player wasn't.
//   AWS_REGION=us-west-2 node test/live-approval.mjs
import { randomBytes, createECDH, createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
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
const lambda = new LambdaClient({ region: REGION });
const hex = (n) => randomBytes(n).toString('hex');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (!cond) failures++;
};

const users = [];
const playerIds = [];
const pushKeys = [];
async function login(label, { admin = false, approved } = {}) {
  const email = `agent-appr-${label}-${hex(3)}@oakhurst-ball.org`;
  const password = `Aa1${hex(12)}`;
  const u = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: `ZZ Appr ${label}` }],
  }));
  users.push(email);
  const sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  if (admin) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const playerId = hex(12);
  playerIds.push(playerId);
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name: `ZZ Appr ${label}`, balanceCents: 0, active: true,
    createdAt: now, updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: `zz appr ${label}`, cognitoSub: sub, email,
    ...(approved != null ? { approved } : {}),
  } }));
  const a = await cognito.send(new InitiateAuthCommand({ ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }));
  const H = { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  return { call, sub, playerId };
}
function fakeSubscription() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const endpoint = `https://fcm.googleapis.com/fcm/send/agent-test-${hex(16)}`;
  const key = { PK: 'PUSH', SK: `SUB#${createHash('sha256').update(endpoint).digest('hex').slice(0, 40)}` };
  pushKeys.push(key);
  return { sub: { endpoint, keys: { p256dh: Buffer.from(ecdh.getPublicKey()).toString('base64url'), auth: randomBytes(16).toString('base64url') } }, key };
}
const exists = async (key) => !!(await ddb.send(new GetCommand({ TableName: TABLE, Key: key }))).Item;

let newPlayerId = null;
try {
  const A = await login('admin', { admin: true });
  const P = await login('player');

  // ── chat approval gate ──
  let r = await P.call('GET', '/chat');
  check('unapproved player: chat is 403 not_approved', r.status === 403 && r.body?.error === 'not_approved', r);
  r = await P.call('POST', '/chat', { text: 'ZZ should not post' });
  check('unapproved player cannot post', r.status === 403, r.status);
  r = await P.call('GET', '/chat/latest');
  check('unapproved player gets no unread info', r.status === 403, r.status);
  r = await P.call('PUT', '/chat/prefs', { chatNotify: true });
  check('unapproved player cannot turn on chat notifications', r.status === 403, r.status);
  r = await A.call('GET', '/chat');
  check('admins can always use the chat', r.status === 200, r.status);

  r = await P.call('POST', `/admin/players/${P.playerId}/approve`, { approved: true });
  check('players cannot approve themselves', r.status === 403, r.status);
  r = await A.call('GET', '/admin/players');
  const row = r.body.players.find((p) => p.playerId === P.playerId);
  check('admin list shows them as an unapproved account', row?.hasAccount === true && row?.approved === false, row);

  r = await A.call('POST', `/admin/players/${P.playerId}/approve`, { approved: true });
  check('admin approves', r.status === 200 && r.body.approved === true, r);
  r = await P.call('GET', '/chat');
  check('approved player can open the chat', r.status === 200 && Array.isArray(r.body.messages), r.status);
  r = await A.call('POST', `/admin/players/${P.playerId}/approve`, { approved: false });
  r = await P.call('GET', '/chat');
  check('access removed → 403 again', r.status === 403, r.status);
  r = await A.call('POST', `/admin/players/${'0'.repeat(24)}/approve`, { approved: true });
  check('unknown player → 404', r.status === 404, r.status);

  r = await A.call('POST', '/admin/players', { name: 'ZZ Appr kiosk-only' });
  const kioskId = r.body?.player?.playerId;
  if (kioskId) playerIds.push(kioskId);
  r = await A.call('GET', '/admin/players');
  const k = r.body.players.find((p) => p.playerId === kioskId);
  check('players an admin adds start approved (no account)', k?.approved === true && k?.hasAccount === false, k);

  // ── new sign-up notification ──
  const adminDev = fakeSubscription();
  const playerDev = fakeSubscription();
  r = await A.call('POST', '/me/push', { subscription: adminDev.sub });
  check('admin test device registered', r.status === 200, r);
  r = await P.call('POST', '/me/push', { subscription: playerDev.sub });
  check('player test device registered', r.status === 200, r);

  const signupSub = crypto.randomUUID();
  const signupEmail = `agent-appr-new-${hex(3)}@oakhurst-ball.org`;
  const t0 = Date.now();
  const inv = await lambda.send(new InvokeCommand({
    FunctionName: 'oakhurst-postauth',
    Payload: Buffer.from(JSON.stringify({
      version: '1', region: REGION, userPoolId: POOL, userName: signupSub, triggerSource: 'PostConfirmation_ConfirmSignUp',
      callerContext: { awsSdkVersion: 'test', clientId: CLIENT },
      request: { userAttributes: { sub: signupSub, email: signupEmail, name: 'ZZ Appr Newbie', email_verified: 'true' } },
      response: {},
    })),
  }));
  const ms = Date.now() - t0;
  check('sign-up trigger succeeds well inside Cognito’s 5 s limit', !inv.FunctionError && ms < 4500, { err: inv.FunctionError, ms });
  const np = (await ddb.send(new QueryCommand({
    TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', FilterExpression: 'cognitoSub = :s',
    ExpressionAttributeValues: { ':pk': 'PLAYER', ':s': signupSub },
  }))).Items?.[0];
  newPlayerId = np?.playerId;
  check('new sign-up gets a player profile that is NOT approved', !!np && !np.approved, np);
  await new Promise((s) => setTimeout(s, 1500));
  check('admins were notified (admin device was pushed to)', !(await exists(adminDev.key)), 'admin device still there');
  check('players were not notified', await exists(playerDev.key), 'player device gone');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  for (const key of pushKeys) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key })).catch(() => {});
  for (const pid of [...playerIds, newPlayerId].filter(Boolean)) {
    const items = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PLAYER#${pid}` } }));
    for (const it of items.Items ?? []) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  }
  for (const u of users) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u })).catch(() => {});
  console.log(`cleanup: ${playerIds.length + (newPlayerId ? 1 : 0)} players, ${users.length} users, ${pushKeys.length} test devices`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
