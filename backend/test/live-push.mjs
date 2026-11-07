// Live test of the Web Push endpoints: key, validation, register, ownership,
// test send (to a fake FCM device, which the push service rejects, so the dead
// device is cleaned up), unregister. Throwaway Cognito users; deletes everything.
//   AWS_REGION=us-west-2 node test/live-push.mjs
import { randomBytes, createECDH, createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
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
const ssm = new SSMClient({ region: REGION });
const hex = (n) => randomBytes(n).toString('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

const users = [];
async function makeUser(label) {
  const email = `agent-push-${label}-${hex(3)}@oakhurst-ball.org`;
  const password = `Aa1${hex(12)}`;
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: `ZZ Push ${label}` }],
  }));
  users.push(email);
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  const a = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const H = { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
  return async (method, path, body) => {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
}

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const endpoint = `https://fcm.googleapis.com/fcm/send/agent-test-${hex(16)}`;
const subscription = { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) } };
const rowKey = { PK: 'PUSH', SK: `SUB#${createHash('sha256').update(endpoint).digest('hex').slice(0, 40)}` };
const row = async () => (await ddb.send(new GetCommand({ TableName: TABLE, Key: rowKey }))).Item;

try {
  const a = await makeUser('a');
  const b = await makeUser('b');

  let r = await a('GET', '/me/push');
  const ssmKey = (await ssm.send(new GetParameterCommand({ Name: '/oakhurst/push/vapid-public' }))).Parameter.Value;
  check('GET /me/push returns the VAPID public key', r.status === 200 && r.body.publicKey === ssmKey, r);

  r = await a('POST', '/me/push', { subscription: { ...subscription, endpoint: 'https://evil.example.com/x' } });
  check('rejects a non-push-service endpoint', r.status === 400 && r.body.error === 'unsupported push service', r);
  r = await a('POST', '/me/push', { subscription: { ...subscription, keys: { p256dh: 'short', auth: 'x' } } });
  check('rejects bad keys', r.status === 400, r);
  r = await a('POST', '/me/push', {});
  check('rejects a missing subscription', r.status === 400, r);

  r = await a('POST', '/me/push', { subscription });
  check('registers a device', r.status === 200 && r.body.subscribed === true, r);
  const stored = await row();
  check('row stored with owner email', stored?.endpoint === endpoint && stored?.email?.startsWith('agent-push-a-'), stored);

  r = await b('DELETE', '/me/push', { endpoint });
  check("another user can't remove it", r.status === 200 && r.body.removed === false && !!(await row()), r);

  r = await a('POST', '/me/push/test');
  check('test send reaches the push service (fake device is rejected)', r.status === 200 && r.body.failed === 1 && r.body.sent === 0, r);
  check('rejected device was deleted', !(await row()), await row());

  r = await a('POST', '/me/push', { subscription });
  r = await a('DELETE', '/me/push', { endpoint });
  check('owner removes it', r.status === 200 && r.body.removed === true && !(await row()), r);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: rowKey })).catch(() => {});
  for (const u of users) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u })).catch(() => {});
  console.log(`cleanup: removed ${users.length} cognito user(s) and the test device`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
