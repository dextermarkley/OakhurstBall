#!/usr/bin/env node
// Mint a kiosk device: writes a KIOSK# record to DynamoDB and prints the device
// ID + token to paste into the iPad's pairing screen (/kiosk). The token is only
// shown once — its scrypt hash is stored, not the token itself.
//
// Usage: node scripts/provision-kiosk.mjs "court-ipad-1" "Main court iPad"
import { randomBytes, scryptSync } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const [deviceId, label] = process.argv.slice(2);
if (!deviceId) {
  console.error('Usage: node scripts/provision-kiosk.mjs <deviceId> [label]');
  process.exit(1);
}

const REGION = process.env.AWS_REGION || 'us-west-2';
const TABLE = process.env.TABLE_NAME || 'oakhurst';

function hashSecret(secret) {
  const salt = randomBytes(16);
  const derived = scryptSync(secret, salt, 32, { N: 16384 });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

const token = randomBytes(24).toString('base64url');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

await ddb.send(
  new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `KIOSK#${deviceId}`,
      SK: 'PROFILE',
      deviceId,
      label: label || deviceId,
      deviceSecretHash: hashSecret(token),
      active: true,
      createdAt: new Date().toISOString(),
    },
  }),
);

console.log('\n✅ Kiosk provisioned. Paste these into the iPad /kiosk pairing screen:\n');
console.log('  Device ID:   ', deviceId);
console.log('  Device token:', token);
console.log('\n(The token is not stored in plaintext and cannot be retrieved again.)\n');
