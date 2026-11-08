// Close any session that is open on ALPHA, the same way an admin's "Close" does
// (closedAt on the session and on the CURRENT pointer). Run by test-alpha.sh
// first, because several suites refuse to run while a session is open.
// Alpha only: it never touches prod.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = 'oakhurst-alpha';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const now = new Date().toISOString();

const ptr = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
if (!ptr || ptr.closedAt || !(ptr.closesAt > now)) {
  console.log('no open session on alpha');
  process.exit(0);
}
const meta = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `SESSION#${ptr.sessionId}`, SK: 'META' } }))).Item;
await ddb.send(
  new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: `SESSION#${ptr.sessionId}`, SK: 'META' },
          UpdateExpression: 'SET closedAt = :now',
          ConditionExpression: 'attribute_not_exists(closedAt)',
          ExpressionAttributeValues: { ':now': now },
        },
      },
      {
        Update: {
          TableName: TABLE,
          Key: { PK: 'CURRENT', SK: 'SESSION' },
          UpdateExpression: 'SET closedAt = :now',
          ConditionExpression: 'sessionId = :sid',
          ExpressionAttributeValues: { ':now': now, ':sid': ptr.sessionId },
        },
      },
    ],
  }),
);
console.log(`closed alpha session ${ptr.sessionId} (opened by ${meta?.openedByName ?? '?'} at ${meta?.openedAt ?? '?'}, ${meta?.attendeeCount ?? 0} checked in)`);
