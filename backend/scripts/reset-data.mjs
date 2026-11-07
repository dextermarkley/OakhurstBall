#!/usr/bin/env node
// Wipe the app back to a clean slate, keeping only the listed admin account(s).
//
// Deletes: every session, check-in, payment, pass, confirm link, player and
//          Cognito user — except the kept admin(s).
// Keeps:   the kept admins' Cognito login, admin group membership, admin record
//          (cash-confirm email), their player profile and kiosk PIN (balance → $0),
//          and paired iPads (use --include-kiosks to un-pair them too).
// Not touched: Stripe keys (SSM), SES email setup, the domain, Stripe's own records.
//
// Dry run by default — prints what it would do. Add --yes to actually delete.
//   node scripts/reset-data.mjs
//   node scripts/reset-data.mjs --yes
//   node scripts/reset-data.mjs --yes --keep someone@example.com --include-kiosks
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const TABLE = process.env.TABLE_NAME ?? 'oakhurst';
const POOL = process.env.USER_POOL_ID ?? 'us-west-2_sgaAJES20';

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const includeKiosks = args.includes('--include-kiosks');
const keepEmails = new Set(['dextermarkley@gmail.com']);
args.forEach((a, i) => a === '--keep' && args[i + 1] && keepEmails.add(args[i + 1].toLowerCase()));

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cognito = new CognitoIdentityProviderClient({ region: REGION });

// ── Cognito users ──
const users = [];
for (let token; ; ) {
  const r = await cognito.send(new ListUsersCommand({ UserPoolId: POOL, PaginationToken: token }));
  users.push(...(r.Users ?? []));
  if (!(token = r.PaginationToken)) break;
}
const attr = (u, n) => u.Attributes?.find((a) => a.Name === n)?.Value;
const keptUsers = users.filter((u) => keepEmails.has((attr(u, 'email') ?? '').toLowerCase()));
const keptSubs = new Set(keptUsers.map((u) => attr(u, 'sub')));
const dropUsers = users.filter((u) => !keptUsers.includes(u));
for (const e of keepEmails) {
  if (!keptUsers.some((u) => (attr(u, 'email') ?? '').toLowerCase() === e)) {
    console.error(`Refusing to run: no Cognito user found for kept email ${e}.`);
    process.exit(1);
  }
}

// ── Table items ──
const items = [];
for (let key; ; ) {
  const r = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: key, ProjectionExpression: 'PK, SK, cognitoSub, email, playerId, #n', ExpressionAttributeNames: { '#n': 'name' } }));
  items.push(...(r.Items ?? []));
  if (!(key = r.LastEvaluatedKey)) break;
}
const keptPlayerIds = new Set(
  items.filter((i) => i.SK === 'PROFILE' && i.PK.startsWith('PLAYER#') && keptSubs.has(i.cognitoSub)).map((i) => i.playerId),
);
const keep = (i) =>
  (i.PK.startsWith('PLAYER#') && i.SK === 'PROFILE' && keptPlayerIds.has(i.playerId)) ||
  (i.PK.startsWith('ADMIN#') && keepEmails.has((i.email ?? '').toLowerCase())) ||
  (i.PK.startsWith('KIOSK#') && !includeKiosks);
const kept = items.filter(keep);
const drop = items.filter((i) => !keep(i));

// ── Report ──
const kind = (i) => `${i.PK.split('#')[0]}/${i.SK.split('#')[0]}`;
const tally = (xs) => Object.entries(xs.reduce((m, i) => ((m[kind(i)] = (m[kind(i)] ?? 0) + 1), m), {})).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`Keeping Cognito users: ${keptUsers.map((u) => attr(u, 'email')).join(', ')}`);
console.log(`Deleting Cognito users (${dropUsers.length}): ${dropUsers.map((u) => attr(u, 'email') ?? u.Username).join(', ') || 'none'}`);
console.log(`Keeping ${kept.length} table items: ${tally(kept) || 'none'}`);
console.log(`Deleting ${drop.length} table items: ${tally(drop) || 'none'}`);
console.log(`Kept player profiles reset to a $0 balance: ${keptPlayerIds.size}`);

if (!apply) {
  console.log('\nDry run — nothing changed. Re-run with --yes to apply.');
  process.exit(0);
}

// ── Apply ──
for (let i = 0; i < drop.length; i += 25) {
  let req = { [TABLE]: drop.slice(i, i + 25).map((x) => ({ DeleteRequest: { Key: { PK: x.PK, SK: x.SK } } })) };
  for (let attempt = 0; req && Object.keys(req).length; attempt++) {
    const r = await ddb.send(new BatchWriteCommand({ RequestItems: req }));
    req = r.UnprocessedItems && Object.keys(r.UnprocessedItems).length ? r.UnprocessedItems : null;
    if (req) await new Promise((s) => setTimeout(s, 200 * (attempt + 1)));
  }
}
for (const pid of keptPlayerIds) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `PLAYER#${pid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET balanceCents = :z, updatedAt = :now',
    ExpressionAttributeValues: { ':z': 0, ':now': new Date().toISOString() },
  }));
}
for (const u of dropUsers) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u.Username }));
for (const u of keptUsers) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: u.Username, GroupName: 'admin' }));

console.log(`\nDone: deleted ${drop.length} items and ${dropUsers.length} users; reset ${keptPlayerIds.size} balance(s) to $0.`);
