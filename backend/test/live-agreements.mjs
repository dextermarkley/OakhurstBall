// Live test of the waiver + rules flow: throwaway user + player, status before,
// validation, signing (adult and minor), immutability, admin view. Cleans up.
//   AWS_REGION=us-west-2 node test/live-agreements.mjs
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand, AdminDeleteUserCommand, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const BASE = 'https://www.oakhurst-ball.org';
const POOL = 'us-west-2_sgaAJES20';
const CLIENT = '2fm9q7bir02ib5upgeeelivdii';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const hex = (n) => randomBytes(n).toString('hex');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (!cond) failures++;
};

const users = [];
const players = [];
async function login(label, { admin = false, player = true } = {}) {
  const email = `agent-waiver-${label}-${hex(3)}@oakhurst-ball.org`;
  const password = `Aa1${hex(12)}`;
  const u = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: `ZZ Waiver ${label}` }],
  }));
  users.push(email);
  const sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  if (admin) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  let playerId = null;
  if (player) {
    playerId = hex(12);
    players.push(playerId);
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({ TableName: 'oakhurst', Item: {
      PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name: `ZZ Waiver ${label}`, balanceCents: 0, active: true,
      createdAt: now, updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: `zz waiver ${label}`, cognitoSub: sub, email,
    } }));
  }
  const a = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const H = { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  return { call, playerId };
}
const records = async (pid) =>
  (await ddb.send(new QueryCommand({ TableName: 'oakhurst', KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':pk': `PLAYER#${pid}`, ':s': 'AGREEMENT#' } }))).Items ?? [];

try {
  const A = await login('admin', { admin: true, player: false });
  const P = await login('adult');
  const M = await login('minor');

  let r = await P.call('GET', '/me/agreements');
  const st = r.body;
  check('new player: not signed, documents served', r.status === 200 && st.current === false && st.signed === null && st.waiver.sections.length >= 8 && st.rules.sections.length >= 5, r);
  const base = { waiverVersion: st.waiver.version, rulesVersion: st.rules.version, agreeRules: true, agreeWaiver: true, adult: true };

  r = await P.call('POST', '/me/agreements', { ...base, agreeWaiver: false, signedName: 'ZZ Adult' });
  check('must agree to the waiver', r.status === 400, r);
  r = await P.call('POST', '/me/agreements', { ...base, signedName: 'Zed' });
  check('must type a full name', r.status === 400, r);
  r = await P.call('POST', '/me/agreements', { ...base, waiverVersion: '1999-01-01', signedName: 'ZZ Adult' });
  check('stale version rejected', r.status === 400, r);

  r = await P.call('POST', '/me/agreements', { ...base, signedName: 'ZZ Adult Player' });
  check('adult signs', r.status === 200 && r.body.current === true, r);
  r = await P.call('GET', '/me/agreements');
  check('now current, with signer name', r.body.current === true && r.body.signed?.signedName === 'ZZ Adult Player', r.body.signed);
  let recs = await records(P.playerId);
  check('two signature records with text hashes and IP', recs.length === 2 && recs.every((x) => x.textSha256?.length === 64 && x.ip && x.at), recs.map((x) => x.SK));
  const firstAt = recs[0].at;

  r = await P.call('POST', '/me/agreements', { ...base, signedName: 'Someone Else' });
  recs = await records(P.playerId);
  check('signing again never overwrites the original record', recs.length === 2 && recs[0].at === firstAt && recs[0].signedName === 'ZZ Adult Player', recs.map((x) => x.signedName));

  r = await M.call('POST', '/me/agreements', { ...base, adult: false, signedName: 'ZZ Minor Player' });
  check('minor without a guardian rejected', r.status === 400, r);
  r = await M.call('POST', '/me/agreements', { ...base, adult: false, signedName: 'ZZ Minor Player', guardianName: 'ZZ Guardian Person' });
  recs = await records(M.playerId);
  check('minor signs with a guardian', r.status === 200 && recs.every((x) => x.guardianName === 'ZZ Guardian Person' && x.adult === false), recs);

  r = await A.call('GET', '/admin/players');
  const row = (pid) => r.body.players.find((p) => p.playerId === pid);
  check('admin list shows who signed which version', r.body.agreementVersions?.waiver === st.waiver.version && row(P.playerId)?.waiverVersion === st.waiver.version && !!row(P.playerId)?.agreedAt, row(P.playerId));
  r = await A.call('GET', '/me/agreements');
  check('admin with no player profile is not blocked', r.body.hasPlayer === false, r.body.hasPlayer);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  for (const pid of players) {
    const items = await ddb.send(new QueryCommand({ TableName: 'oakhurst', KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PLAYER#${pid}` } }));
    for (const it of items.Items ?? []) await ddb.send(new DeleteCommand({ TableName: 'oakhurst', Key: { PK: it.PK, SK: it.SK } }));
  }
  for (const u of users) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u })).catch(() => {});
  console.log(`cleanup: ${players.length} players, ${users.length} users`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
