// Make someone an admin on a stage: Cognito account (invited by email with a
// temporary password if they don't have one), the 'admin' group, a linked player
// profile, and an admin record (so players can hand them cash).
//   node scripts/add-admin.mjs <alpha|prod> <email> "<Name>"
// Run from the repo root; uses the backend's AWS SDK packages.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const require = createRequire(new URL('../backend/package.json', import.meta.url));
const C = require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const [stage, rawEmail, name] = process.argv.slice(2);
if (!['alpha', 'prod'].includes(stage) || !rawEmail || !name) {
  console.error('usage: node scripts/add-admin.mjs <alpha|prod> <email> "<Name>"');
  process.exit(2);
}
const email = rawEmail.trim().toLowerCase();
const region = 'us-west-2';
const stack = stage === 'prod' ? 'OakhurstBasketball' : 'OakhurstBasketballAlpha';
const out = Object.fromEntries(
  JSON.parse(
    execFileSync('aws', ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', stack, '--query', 'Stacks[0].Outputs', '--output', 'json']),
  ).map((o) => [o.OutputKey, o.OutputValue]),
);
const POOL = out.UserPoolId;
const TABLE = out.TableName;
const cog = new C.CognitoIdentityProviderClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
const hex = (n) => randomBytes(n).toString('hex');
const now = new Date().toISOString();

// 1. Cognito account
let sub;
try {
  const u = await cog.send(new C.AdminGetUserCommand({ UserPoolId: POOL, Username: email }));
  sub = u.UserAttributes.find((a) => a.Name === 'sub').Value;
  console.log(`account exists (${sub})`);
} catch (e) {
  if (e.name !== 'UserNotFoundException') throw e;
  const u = await cog.send(
    new C.AdminCreateUserCommand({
      UserPoolId: POOL,
      Username: email,
      DesiredDeliveryMediums: ['EMAIL'], // Cognito emails a temporary password
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
    }),
  );
  sub = u.User.Attributes.find((a) => a.Name === 'sub').Value;
  console.log(`account created and invite emailed to ${email} (${sub})`);
}
await cog.send(new C.AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
console.log('in the admin group');

// 2. Player profile linked to the account (sign-up normally makes this).
const players = await ddb.send(
  new QueryCommand({
    TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p', FilterExpression: 'cognitoSub = :s',
    ExpressionAttributeValues: { ':p': 'PLAYER', ':s': sub },
  }),
);
if (players.Items?.length) {
  console.log('player profile exists');
} else {
  const playerId = hex(12);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name, email, cognitoSub: sub, balanceCents: 0, active: true,
    approved: true, createdAt: now, updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: name.toLowerCase(),
  } }));
  console.log(`player profile created (${playerId})`);
}

// 3. Admin record (cash recipient), linked by account.
const admins = await ddb.send(
  new QueryCommand({ TableName: TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p', ExpressionAttributeValues: { ':p': 'ADMIN' } }),
);
if (admins.Items?.some((a) => a.cognitoSub === sub || a.email === email)) {
  console.log('admin record exists');
} else {
  const adminId = hex(12);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    PK: `ADMIN#${adminId}`, SK: 'PROFILE', adminId, name, email, cognitoSub: sub, active: true, createdAt: now,
    GSI1PK: 'ADMIN', GSI1SK: name.toLowerCase(),
  } }));
  console.log(`admin record created (${adminId})`);
}
