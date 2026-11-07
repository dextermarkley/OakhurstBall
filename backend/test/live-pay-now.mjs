// Live test of "Pay now" from the player page (no session needed): lists cashiers,
// records a $5 cash payment to a throwaway admin with NO email (no email is sent),
// confirms it, and checks the balance. Deletes everything it created.
//   AWS_REGION=us-west-2 node test/live-pay-now.mjs
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
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

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

const playerId = hex(12);
const cashAdminId = hex(12);
const email = `agent-paynow-${hex(4)}@oakhurst-ball.org`;
const password = `Aa1${hex(12)}`;
let A = {};
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}/api${path}`, { method, headers: A, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const balance = async () =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${playerId}`, SK: 'PROFILE' } }))).Item?.balanceCents;

try {
  const u = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: 'ZZ PayNow' }],
  }));
  const sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const auth = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  A = { 'content-type': 'application/json', authorization: `Bearer ${auth.AuthenticationResult.IdToken}` };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `ADMIN#${cashAdminId}`, SK: 'PROFILE', adminId: cashAdminId, name: 'ZZ Test Cashier', active: true,
    GSI1PK: 'ADMIN', GSI1SK: 'zz test cashier', createdAt: new Date().toISOString(),
  } }));
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name: 'ZZ PayNow', balanceCents: -500, active: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    GSI1PK: 'PLAYER', GSI1SK: 'zz paynow', cognitoSub: sub,
  } }));

  let r = await api('GET', '/me/admins');
  const listed = r.body?.admins?.find((a) => a.adminId === cashAdminId);
  check('GET /me/admins lists the cashier', r.status === 200 && listed?.name === 'ZZ Test Cashier', r);
  check('GET /me/admins does not expose emails', r.body?.admins?.every((a) => !('email' in a)), r.body);

  r = await api('POST', '/me/pay-cash', {});
  check('pay-cash without adminId → 400', r.status === 400, r);
  r = await api('POST', '/me/pay-cash', { adminId: hex(12) });
  check('pay-cash with unknown admin → 404', r.status === 404, r);
  r = await api('POST', '/me/pay-cash', { adminId: cashAdminId, plan: 'bogus' });
  check('pay-cash with bad plan → 400', r.status === 400, r);

  r = await api('POST', '/me/pay-cash', { adminId: cashAdminId });
  const paymentId = r.body?.paymentId;
  check('pay-cash $5 → 201 pending, not emailed',
    r.status === 201 && r.body.amountCents === 500 && r.body.emailed === false && r.body.adminName === 'ZZ Test Cashier', r);
  check('balance unchanged until confirmed', (await balance()) === -500, await balance());

  r = await api('GET', '/admin/pending');
  check('shows up in admin pending list', JSON.stringify(r.body).includes(paymentId), r.status);

  r = await api('POST', `/admin/payments/${paymentId}/confirm`);
  check('admin confirms', r.status === 200, r);
  check('balance credited to $0', (await balance()) === 0, await balance());

  r = await api('POST', '/me/pay-cash', { adminId: cashAdminId, plan: 'quarter' });
  check('pay-cash quarter pass → $80 pending', r.status === 201 && r.body.amountCents === 8000, r);
  r = await api('POST', `/admin/payments/${r.body?.paymentId}/deny`);
  check('admin denies the quarter cash', r.status === 200, r);
  check('balance still $0 after deny', (await balance()) === 0, await balance());
} catch (err) {
  console.error(err);
  failures++;
} finally {
  const items = await ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}` },
  }));
  for (const it of items.Items ?? []) {
    if (it.paymentId) {
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PAYREF#${it.paymentId}`, SK: 'REF' } }));
      if (it.confirmToken) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `TOKEN#${it.confirmToken}`, SK: 'TOKEN' } }));
    }
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `ADMIN#${cashAdminId}`, SK: 'PROFILE' } }));
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: email })).catch(() => {});
  console.log(`cleanup: removed ${items.Items?.length ?? 0} player item(s), cashier, cognito user`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
