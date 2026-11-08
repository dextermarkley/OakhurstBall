// Live test of adding (admins only) and removing a kiosk: pair a throwaway kiosk through the admin API,
// check it works, remove it, check it's locked out. Throwaway users; cleans up.
//   AWS_REGION=us-west-2 node test/live-kiosk-remove.mjs
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand, AdminDeleteUserCommand, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { BASE, TABLE, POOL, CLIENT } from './env.mjs';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const hex = (n) => randomBytes(n).toString('hex');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

const users = [];
async function login(label, admin) {
  const email = `agent-kiosk-${label}-${hex(3)}@oakhurst-ball.org`;
  const password = `Aa1${hex(12)}`;
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }));
  users.push(email);
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  if (admin) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const a = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  return { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
}
const call = async (method, path, headers, body) => {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

const deviceId = `agent-remove-${hex(3)}`;
try {
  const A = await login('admin', true);
  const P = await login('player', false);

  // ── Only admins can add a kiosk ──
  const sneaky = `agent-sneaky-${hex(3)}`;
  const exists = async (id) => !!(await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `KIOSK#${id}`, SK: 'PROFILE' } }))).Item;
  let r = await call('POST', '/api/admin/kiosks', P, { deviceId: sneaky });
  check('a signed-in player cannot add a kiosk (403)', r.status === 403 && !(await exists(sneaky)), r);
  r = await call('POST', '/api/admin/kiosks', { 'content-type': 'application/json' }, { deviceId: sneaky });
  check('no sign-in cannot add a kiosk (401)', r.status === 401 && !(await exists(sneaky)), r.status);
  r = await call('POST', '/api/admin/kiosks', { 'content-type': 'application/json', authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJjb2duaXRvOmdyb3VwcyI6WyJhZG1pbiJdfQ.' }, { deviceId: sneaky });
  check('a forged "admin" token cannot add a kiosk (401)', r.status === 401 && !(await exists(sneaky)), r.status);
  r = await call('GET', '/api/admin/kiosks', P);
  check('players cannot list kiosks', r.status === 403, r.status);
  for (const trick of ['/api/kiosk/../admin/kiosks', '/api/kiosk/%2e%2e/admin/kiosks', '/api/media/..%2fadmin%2fkiosks', '/api/stripe/../admin/kiosks']) {
    r = await call('POST', trick, { 'content-type': 'application/json' }, { deviceId: sneaky });
    check(`path trick ${trick} doesn't add a kiosk`, !(await exists(sneaky)) && r.status !== 201, r.status);
  }
  r = await call('GET', '/api/kiosk/players', { 'x-kiosk-device': sneaky, 'x-kiosk-token': 'made-up-token' });
  check('a made-up device + token is not a kiosk', r.status === 401, r.status);

  r = await call('POST', '/api/admin/kiosks', A, { deviceId, label: 'ZZ removal test' });
  check('admin pairs a test kiosk', r.status === 201 && !!r.body.token, r);
  const K = { 'x-kiosk-device': deviceId, 'x-kiosk-token': r.body.token };
  r = await call('GET', '/api/kiosk/players', K);
  check('the kiosk works', r.status === 200, r.status);

  r = await call('DELETE', `/api/admin/kiosks/${deviceId}`, P);
  check("players can't remove kiosks", r.status === 403, r);
  r = await call('DELETE', `/api/admin/kiosks/${deviceId}`, A);
  check('admin removes it', r.status === 200 && r.body.removed === true, r);
  r = await call('GET', '/api/kiosk/players', K);
  check('the removed kiosk is locked out (sends it to pairing)', r.status === 401 && r.body?.error === 'bad kiosk token', r);
  r = await call('GET', '/api/admin/kiosks', A);
  check('gone from the kiosks list', !r.body.kiosks.some((k) => k.deviceId === deviceId), r.body);
  r = await call('DELETE', `/api/admin/kiosks/${deviceId}`, A);
  check('removing again is harmless', r.status === 200 && r.body.removed === false, r);
  r = await call('DELETE', '/api/admin/kiosks/..%2fx', A);
  check('bad device id → 404', r.status === 404, r.status);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  const left = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `KIOSK#${deviceId}`, SK: 'PROFILE' } }));
  if (left.Item) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `KIOSK#${deviceId}`, SK: 'PROFILE' } }));
  for (const u of users) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u })).catch(() => {});
  console.log(`cleanup: ${users.length} users${left.Item ? ', leftover kiosk' : ''}`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
