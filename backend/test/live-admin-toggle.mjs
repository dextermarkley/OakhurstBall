// Making a player an admin from Admin → Players, and taking it away.
// Throwaway admin + player (+ a kiosk-only player); cleans up.
//   AWS_REGION=us-west-2 node test/live-admin-toggle.mjs
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
async function person(label, { admin = false, account = true } = {}) {
  const playerId = hex(12);
  players.push(playerId);
  const name = `ZZ Toggle ${label} ${hex(2)}`;
  const now = new Date().toISOString();
  let sub, email, password, auth;
  if (account) {
    email = `agent-toggle-${label}-${hex(3)}@oakhurst-ball.org`;
    password = `Aa1${hex(8)}`;
    const u = await cog.send(new C.AdminCreateUserCommand({ UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: name }] }));
    users.push(email);
    sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
    await cog.send(new C.AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
    if (admin) await cog.send(new C.AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  }
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name, email, cognitoSub: sub,
    balanceCents: 0, active: true, approved: false, createdAt: now, updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: name.toLowerCase() } }));
  const signIn = async () =>
    (await cog.send(new C.InitiateAuthCommand({ ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } })))
      .AuthenticationResult;
  const call = async (method, path, body, tok) => {
    const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { playerId, name, sub, email, signIn, call };
}
const groups = async (email) =>
  (await cog.send(new C.AdminListGroupsForUserCommand({ UserPoolId: POOL, Username: email }))).Groups.map((g) => g.GroupName);
const adminRecord = async (sub) =>
  (await ddb.send(new QueryCommand({ TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p', FilterExpression: 'cognitoSub = :s',
    ExpressionAttributeValues: { ':p': 'ADMIN', ':s': sub } }))).Items?.[0];

let made = [];
try {
  const A = await person('boss', { admin: true });
  const P = await person('helper');
  const K = await person('walkin', { account: false });
  const a = (await A.signIn()).IdToken;
  const pAuth = await P.signIn();

  let r = await P.call('POST', `/api/admin/players/${K.playerId}/admin`, { admin: true }, pAuth.IdToken);
  check('a player can’t make anyone an admin (403)', r.status === 403, r);

  r = await A.call('GET', '/api/admin/players', null, a);
  const row = (id) => r.body.players.find((x) => x.playerId === id);
  check('players list: not an admin yet', row(P.playerId)?.isAdmin === false && row(A.playerId)?.isAdmin === true && row(A.playerId)?.isMe === true, [row(P.playerId), row(A.playerId)]);
  check('players list never shows account ids', !JSON.stringify(r.body).includes('cognitoSub'));

  r = await A.call('POST', `/api/admin/players/${P.playerId}/admin`, { admin: 'yes' }, a);
  check('admin must be true/false', r.status === 400, r);
  r = await A.call('POST', `/api/admin/players/${K.playerId}/admin`, { admin: true }, a);
  check('kiosk-only player (no account) can’t be made admin', r.status === 400 && /sign up/.test(r.body?.error), r);

  r = await A.call('POST', `/api/admin/players/${P.playerId}/admin`, { admin: true }, a);
  check('make admin', r.status === 200, r);
  const rec = await adminRecord(P.sub);
  if (rec) made.push(rec);
  check('in the admin group + active cash-recipient record + chat approved',
    (await groups(P.email)).includes('admin') && rec?.active === true && rec?.name === P.name, { rec });
  const newTok = (await P.signIn()).IdToken;
  r = await P.call('GET', '/api/admin/players', null, newTok);
  check('their next sign-in has admin access', r.status === 200, r.status);
  r = await A.call('GET', '/api/me/admins', null, a);
  check('players can now hand them cash', r.body.admins.some((x) => x.adminId === rec?.adminId), r.body);
  r = await A.call('POST', `/api/admin/players/${P.playerId}/admin`, { admin: true }, a);
  check('making them admin again is harmless (one record)', r.status === 200 &&
    (await ddb.send(new QueryCommand({ TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p', FilterExpression: 'cognitoSub = :s',
      ExpressionAttributeValues: { ':p': 'ADMIN', ':s': P.sub } }))).Items.length === 1);

  r = await A.call('POST', `/api/admin/players/${A.playerId}/admin`, { admin: false }, a);
  check('you can’t remove your own admin access', r.status === 400 && /your own/.test(r.body?.error), r);

  r = await A.call('POST', `/api/admin/players/${P.playerId}/admin`, { admin: false }, a);
  check('remove admin', r.status === 200, r);
  check('out of the group, record inactive (kept)', !(await groups(P.email)).includes('admin') && (await adminRecord(P.sub))?.active === false);
  let refreshed = 'worked';
  try {
    await cog.send(new C.InitiateAuthCommand({ ClientId: CLIENT, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: pAuth.RefreshToken } }));
  } catch (e) { refreshed = e.name; }
  check('they were signed out everywhere (old sign-in can’t refresh)', refreshed !== 'worked', refreshed);
  r = await P.call('GET', '/api/admin/players', null, (await P.signIn()).IdToken);
  check('signing in again: no admin access', r.status === 403, r.status);
  r = await A.call('GET', '/api/me/admins', null, a);
  check('players can no longer pick them for cash', !r.body.admins.some((x) => x.adminId === rec?.adminId));
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  for (const rec of made) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `ADMIN#${rec.adminId}`, SK: 'PROFILE' } }));
  for (const pid of players) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PLAYER#${pid}`, SK: 'PROFILE' } }));
  for (const e of users) await cog.send(new C.AdminDeleteUserCommand({ UserPoolId: POOL, Username: e })).catch(() => {});
  console.log(`cleanup: ${made.length} admin records, ${players.length} players, ${users.length} users`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
