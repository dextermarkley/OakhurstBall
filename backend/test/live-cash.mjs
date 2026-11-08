// Live cash-flow test: throwaway kiosk + player, check in ($5 fee), pay $5 cash to a
// real admin, which sends a REAL confirm email. Leaves the player in place so the
// admin can click the emailed link; run with --cleanup <playerId> <deviceId> after.
//   AWS_REGION=us-west-2 node test/live-cash.mjs <adminId>
//   AWS_REGION=us-west-2 node test/live-cash.mjs --cleanup <playerId> <deviceId>
import { randomBytes, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const BASE = 'https://www.oakhurst-ball.org';
const TABLE = 'oakhurst';
// Fixture players have signed the current waiver + rules (see src/lib/agreements.ts).
const SIGNED = { waiverVersion: '2026-11-07', rulesVersion: '2026-11-07.2', agreedAt: '2026-11-07T00:00:00.000Z', signedName: 'ZZ Test' };
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-west-2' }));

async function cleanup(playerId, deviceId) {
  const items = await ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}` },
  }));
  for (const it of items.Items ?? []) {
    if (it.paymentId) {
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PAYREF#${it.paymentId}`, SK: 'REF' } }));
      if (it.confirmToken) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `TOKEN#${it.confirmToken}`, SK: 'TOKEN' } }));
      if (it.confirmTokenHash) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `TOKENH#${it.confirmTokenHash}`, SK: 'TOKEN' } }));
    }
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `KIOSK#${deviceId}`, SK: 'PROFILE' } }));
  console.log(`cleanup: removed ${items.Items?.length ?? 0} player item(s) + kiosk ${deviceId}`);
}

if (process.argv[2] === '--cleanup') {
  const [playerId, deviceId] = process.argv.slice(3);
  const p = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${playerId}`, SK: 'PROFILE' } }));
  console.log('final balanceCents:', p.Item?.balanceCents);
  const pays = await ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':s': 'PAYMENT#' },
  }));
  for (const x of pays.Items ?? []) console.log('payment:', x.method, x.amountCents, x.status);
  await cleanup(playerId, deviceId);
  process.exit(0);
}

const adminId = process.argv[2];
if (!adminId) { console.error('usage: live-cash.mjs <adminId>'); process.exit(1); }

const hash = (s) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(s, salt, 32, { N: 16384 }).toString('hex')}`;
};
const deviceId = `agent-cash-${randomBytes(3).toString('hex')}`;
const token = randomBytes(24).toString('base64url');
const playerId = randomBytes(12).toString('hex');
const PIN = '4821';
const H = { 'content-type': 'application/json', 'x-kiosk-device': deviceId, 'x-kiosk-token': token };
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

await ddb.send(new PutCommand({ TableName: TABLE, Item: {
  PK: `KIOSK#${deviceId}`, SK: 'PROFILE', deviceId, label: 'agent cash test',
  deviceSecretHash: hash(token), active: true, createdAt: new Date().toISOString(),
} }));
await ddb.send(new PutCommand({ TableName: TABLE, Item: {
  PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name: 'Cash Test (delete me)', pinHash: hash(PIN),
  balanceCents: 0, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  GSI1PK: 'PLAYER', ...SIGNED, GSI1SK: 'zz cash test',
} }));

const ci = await post('/api/kiosk/checkin', { playerId, pin: PIN });
console.log('checkin:', ci.status, { feeCents: ci.body.feeCents, balanceCents: ci.body.balanceCents, owes: ci.body.owes });

const pay = await post('/api/kiosk/pay', { playerId, pin: PIN, method: 'cash', adminId });
console.log('cash pay:', pay.status, pay.body);
console.log(`\nplayerId=${playerId} deviceId=${deviceId}`);
