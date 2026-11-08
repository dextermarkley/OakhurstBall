// Only an admin can generate a kiosk pairing code. Tries every other credential
// and path trick against POST /api/admin/kiosks and checks each is refused AND
// that no kiosk record was written; then checks an admin can. Cleans up.
//   AWS_REGION=us-west-2 node test/live-kiosk-admin.mjs
import { randomBytes, createHash } from 'node:crypto';
import * as C from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { BASE, TABLE, POOL, CLIENT, STAGE } from './env.mjs';

const OTHER = STAGE === 'prod'
  ? { POOL: 'us-west-2_5u6ysfKDp', CLIENT: '3sam8fji3f5oupm62iv4ldta8h' }
  : { POOL: 'us-west-2_sgaAJES20', CLIENT: '2fm9q7bir02ib5upgeeelivdii' };
const cog = new C.CognitoIdentityProviderClient({ region: 'us-west-2' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const hex = (n) => randomBytes(n).toString('hex');
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  if (!cond) failed++;
};
const users = [];
async function user(pool, client, admin) {
  const email = `agent-kadmin-${hex(3)}@oakhurst-ball.org`, password = `Aa1${hex(8)}`;
  await cog.send(new C.AdminCreateUserCommand({ UserPoolId: pool, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: 'ZZ Kiosk Probe' }] }));
  users.push([pool, email]);
  await cog.send(new C.AdminSetUserPasswordCommand({ UserPoolId: pool, Username: email, Password: password, Permanent: true }));
  if (admin) await cog.send(new C.AdminAddUserToGroupCommand({ UserPoolId: pool, Username: email, GroupName: 'admin' }));
  const a = await cog.send(new C.InitiateAuthCommand({ ClientId: client, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }));
  return a.AuthenticationResult;
}
const kioskKey = (id) => ({ PK: `KIOSK#${id}`, SK: 'PROFILE' });
const made = [];
const exists = async (id) => !!(await ddb.send(new GetCommand({ TableName: TABLE, Key: kioskKey(id) }))).Item;

const kid = `zz-kadmin-${hex(3)}`, ktok = randomBytes(24).toString('base64url');
try {
  const player = await user(POOL, CLIENT, false);
  const foreignAdmin = await user(OTHER.POOL, OTHER.CLIENT, true);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...kioskKey(kid), deviceId: kid, active: true,
    deviceSecretHash: 'sha256:' + createHash('sha256').update(ktok).digest('hex') } }));
  made.push(kid);
  const [h, p, s] = player.IdToken.split('.');
  const asAdmin = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), 'cognito:groups': ['admin'] })).toString('base64url');
  const attempts = [
    ['/api/admin/kiosks', 'no credentials', {}],
    ['/api/admin/kiosks', 'garbage token', { authorization: 'Bearer abc.def.ghi' }],
    ['/api/admin/kiosks', 'signed-in player (ID token)', { authorization: `Bearer ${player.IdToken}` }],
    ['/api/admin/kiosks', 'signed-in player (access token)', { authorization: `Bearer ${player.AccessToken}` }],
    ['/api/admin/kiosks', 'player token edited to claim admin', { authorization: `Bearer ${h}.${asAdmin}.${s}` }],
    ['/api/admin/kiosks', 'unsigned (alg none) admin token', { authorization: `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${asAdmin}.` }],
    ['/api/admin/kiosks', 'admin of the other stack’s user pool', { authorization: `Bearer ${foreignAdmin.IdToken}` }],
    ['/api/admin/kiosks', 'a paired kiosk’s own credentials', { 'x-kiosk-device': kid, 'x-kiosk-token': ktok }],
    ['/api/kiosk/../admin/kiosks', 'kiosk credentials + ../ path', { 'x-kiosk-device': kid, 'x-kiosk-token': ktok }],
    ['/api/kiosk/admin/kiosks', 'kiosk credentials + kiosk route', { 'x-kiosk-device': kid, 'x-kiosk-token': ktok }],
    ['/API/admin/kiosks', 'upper-case path', { 'x-kiosk-device': kid, 'x-kiosk-token': ktok }],
    ['/api//admin/kiosks', 'double slash', {}],
    ['/api/admin/kiosks/', 'trailing slash, player', { authorization: `Bearer ${player.IdToken}` }],
  ];
  for (const [path, label, hdrs] of attempts) {
    const dev = `zz-kadmin-${hex(3)}`;
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...hdrs }, body: JSON.stringify({ deviceId: dev, label: 'probe' }) });
    const body = await r.text();
    const wrote = await exists(dev);
    if (wrote) made.push(dev);
    check(`${label} (${path}) → refused, no kiosk made`, r.status >= 400 && !wrote && !body.includes('"token"'), { status: r.status, wrote });
  }
  // Listing and removing need an admin too.
  const list = await fetch(BASE + '/api/admin/kiosks', { headers: { authorization: `Bearer ${player.IdToken}` } });
  check('player can’t list kiosks', list.status === 403, list.status);
  const del = await fetch(`${BASE}/api/admin/kiosks/${kid}`, { method: 'DELETE', headers: { authorization: `Bearer ${player.IdToken}` } });
  check('player can’t remove a kiosk', del.status === 403 && (await exists(kid)), del.status);

  // An admin can, and gets the code once.
  const adm = await user(POOL, CLIENT, true);
  const dev = `zz-kadmin-${hex(3)}`;
  made.push(dev);
  const ok = await fetch(BASE + '/api/admin/kiosks', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adm.IdToken}` },
    body: JSON.stringify({ deviceId: dev, label: 'probe' }) });
  const okBody = await ok.json().catch(() => ({}));
  check('admin can generate a pairing code', ok.status === 201 && typeof okBody.token === 'string' && (await exists(dev)), ok.status);
  const stored = (await ddb.send(new GetCommand({ TableName: TABLE, Key: kioskKey(dev) }))).Item;
  check('only a hash of the code is stored', stored?.deviceSecretHash?.startsWith('sha256:') && !JSON.stringify(stored).includes(okBody.token));
  const again = await fetch(BASE + '/api/admin/kiosks', { headers: { authorization: `Bearer ${adm.IdToken}` } });
  check('the kiosk list never shows the code', again.status === 200 && !(await again.text()).includes(okBody.token));
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  for (const id of made) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: kioskKey(id) })).catch(() => {});
  for (const [pool, e] of users) await cog.send(new C.AdminDeleteUserCommand({ UserPoolId: pool, Username: e })).catch(() => {});
  console.log(`cleanup: ${made.length} kiosks, ${users.length} users`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
