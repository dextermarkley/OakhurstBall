// Live smoke test against the deployed stack. Creates a throwaway kiosk device and
// test player, exercises check-in / daily fee / card-not-configured paths, then
// deletes everything it created. Does NOT send SMS (cash path skipped).
//   AWS_REGION=us-west-2 node test/live-smoke.mjs [baseUrl]
import { randomBytes, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { BASE, TABLE } from './env.mjs';

// Fixture players have signed the current waiver + rules (see src/lib/agreements.ts).
const SIGNED = { waiverVersion: '2026-11-07', rulesVersion: '2026-11-07.2', agreedAt: '2026-11-07T00:00:00.000Z', signedName: 'ZZ Test' };
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-west-2' }));
const hash = (s) => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(s, salt, 32, { N: 16384 }).toString('hex')}`;
};

const deviceId = `agent-test-${randomBytes(3).toString('hex')}`;
const token = randomBytes(24).toString('base64url');
const playerId = randomBytes(12).toString('hex');
const PIN = '4821';
const H = { 'content-type': 'application/json', 'x-kiosk-device': deviceId, 'x-kiosk-token': token };

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};
const call = async (path, body, headers = H) => {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

try {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `KIOSK#${deviceId}`, SK: 'PROFILE', deviceId, label: 'agent smoke test',
    deviceSecretHash: hash(token), active: true, createdAt: new Date().toISOString(),
  } }));
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name: 'ZZ Agent Test', pinHash: hash(PIN),
    balanceCents: 0, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    GSI1PK: 'PLAYER', ...SIGNED, GSI1SK: 'zz agent test',
  } }));

  let r = await call('/api/kiosk/players');
  check('kiosk lists players with device token', r.status === 200 && r.body.players.some((p) => p.playerId === playerId), r);

  r = await call('/api/kiosk/players', null, { 'x-kiosk-device': deviceId, 'x-kiosk-token': 'wrong' });
  check('kiosk rejects a bad device token', r.status === 401, r);

  r = await call('/api/kiosk/checkin', { playerId, pin: '0000' });
  check('wrong PIN rejected, no charge', r.status === 401 && r.body.error === 'wrong PIN', r);

  // Session check-in itself is covered by live-sessions.mjs.
  r = await call('/api/kiosk/session');
  check('kiosk session endpoint answers', r.status === 200 && 'session' in r.body, r);

  r = await call('/api/kiosk/pay', { playerId, pin: PIN, method: 'card' });
  check('card pay → $20 Stripe checkout', r.status === 201 && r.body.amountCents === 2000 && /checkout\.stripe\.com/.test(r.body.checkoutUrl ?? ''), r.body);

  r = await call('/api/kiosk/pay', { playerId, pin: PIN, method: 'card', amountCents: 1 });
  check('client cannot pick an amount (server still charges $20, not $0.01)', r.status === 201 && r.body.amountCents === 2000, r.body);

  r = await call('/api/kiosk/pay', { playerId, pin: PIN, method: 'venmo' });
  check('unknown method rejected', r.status === 400, r);

  r = await call('/api/kiosk/payments/000000000000000000000000');
  check('unknown payment → 404', r.status === 404, r);

  r = await call('/api/stripe/return?session_id=cs_test_nope', null, {});
  check('stripe return with an unknown session → 404, not a server error', r.status === 404, r);

  r = await call('/api/stripe/webhook', { type: 'x' }, { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' });
  check('stripe webhook rejects a forged signature', r.status === 400 && r.body?.error === 'bad signature', r);

  const page = await fetch(BASE + '/paid?session_id=x');
  check('/paid page served', page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html'), page.status);
} finally {
  // Clean up everything this test created.
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

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
