// Making a player an admin, or taking it away, from the Admin → Players screen.
//
// Admin rights are the Cognito 'admin' group (what the API checks). An ADMIN#
// record makes them someone players can hand cash to. Granting does both;
// removing takes them out of the group, marks the record inactive (kept, because
// past payments name it), signs them out everywhere so the change takes effect
// at once, and stops admin-only notifications to their devices.
import {
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1, keys, gsi } from './ddb.js';
import { newId } from './crypto.js';
import { queryAll } from './page.js';
import type { Player } from './types.js';

const cog = new CognitoIdentityProviderClient({});
const POOL = () => {
  const p = process.env.USER_POOL_ID;
  if (!p) throw new Error('USER_POOL_ID is not set');
  return p;
};
const GROUP = 'admin';

/** Cognito subs of everyone in the admin group (follows pagination). */
export async function adminSubs(): Promise<Set<string>> {
  const out = new Set<string>();
  let token: string | undefined;
  do {
    const r = await cog.send(new ListUsersInGroupCommand({ UserPoolId: POOL(), GroupName: GROUP, NextToken: token, Limit: 60 }));
    for (const u of r.Users ?? []) {
      const sub = u.Attributes?.find((a) => a.Name === 'sub')?.Value;
      if (sub) out.add(sub);
    }
    token = r.NextToken;
  } while (token);
  return out;
}

/** The ADMIN# record for this account (by sub, else by email), if any. */
async function findAdminRecord(sub: string, email?: string) {
  const items = await queryAll<any>({
    TableName: TABLE,
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'ADMIN' },
  });
  return (
    items.find((a) => a.cognitoSub === sub) ??
    (email ? items.find((a) => !a.cognitoSub && a.email?.toLowerCase() === email.toLowerCase()) : undefined)
  );
}

export type SetAdminResult = 'done' | 'no_account' | 'self' | 'last_admin';

export async function setPlayerAdmin(player: Player, on: boolean, by: { sub: string }): Promise<SetAdminResult> {
  const sub = player.cognitoSub;
  if (!sub) return 'no_account';
  const username = sub; // email sign-in: the username is the sub
  if (!on) {
    if (sub === by.sub) return 'self'; // can't lock yourself out
    const subs = await adminSubs();
    if (subs.has(sub) && subs.size <= 1) return 'last_admin';
  }
  const now = new Date().toISOString();
  const rec = await findAdminRecord(sub, player.email);

  if (on) {
    await cog.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL(), Username: username, GroupName: GROUP }));
    if (rec) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: keys.adminProfile(rec.adminId),
          UpdateExpression: 'SET active = :t, cognitoSub = :s, #n = :n, updatedAt = :now' + (player.email ? ', email = :e' : ''),
          ExpressionAttributeNames: { '#n': 'name' },
          ExpressionAttributeValues: { ':t': true, ':s': sub, ':n': player.name, ':now': now, ...(player.email ? { ':e': player.email } : {}) },
        }),
      );
    } else {
      const adminId = newId();
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            ...keys.adminProfile(adminId),
            adminId,
            name: player.name,
            email: player.email,
            cognitoSub: sub,
            active: true,
            createdAt: now,
            ...gsi.adminList(),
            GSI1SK: player.name.toLowerCase(),
          },
        }),
      );
    }
    // Admins can always use the chat.
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: keys.playerProfile(player.playerId),
        UpdateExpression: 'SET approved = :t, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':t': true, ':now': now },
      }),
    );
    return 'done';
  }

  await cog.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: POOL(), Username: username, GroupName: GROUP }));
  if (rec) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: keys.adminProfile(rec.adminId),
        UpdateExpression: 'SET active = :f, updatedAt = :now',
        ExpressionAttributeValues: { ':f': false, ':now': now },
      }),
    );
  }
  // Their devices stop getting admin-only notifications (new sign-ups, refunds).
  const devices = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
      FilterExpression: '#o = :sub',
      ExpressionAttributeNames: { '#o': 'sub' },
      ExpressionAttributeValues: { ':pk': 'PUSH', ':s': 'SUB#', ':sub': sub },
    }),
  );
  for (const d of devices.Items ?? []) {
    await ddb.send(
      new UpdateCommand({ TableName: TABLE, Key: { PK: d.PK, SK: d.SK }, UpdateExpression: 'SET isAdmin = :f', ExpressionAttributeValues: { ':f': false } }),
    );
  }
  // Their current sign-in carries the admin group for up to an hour; end it now.
  await cog.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL(), Username: username })).catch(() => {});
  return 'done';
}
