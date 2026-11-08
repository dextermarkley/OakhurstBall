// DynamoDB document client + key helpers for the single-table design.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const base = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE = process.env.TABLE_NAME!;
export const GSI1 = process.env.GSI1_NAME ?? 'GSI1';

// ── Key builders — the single source of truth for the table layout. ──────────
export const keys = {
  playerProfile: (playerId: string) => ({ PK: `PLAYER#${playerId}`, SK: 'PROFILE' }),
  adminProfile: (adminId: string) => ({ PK: `ADMIN#${adminId}`, SK: 'PROFILE' }),
  kioskProfile: (deviceId: string) => ({ PK: `KIOSK#${deviceId}`, SK: 'PROFILE' }),
  checkin: (playerId: string, iso: string) => ({ PK: `PLAYER#${playerId}`, SK: `CHECKIN#${iso}` }),
  payment: (playerId: string, iso: string, paymentId: string) => ({
    PK: `PLAYER#${playerId}`,
    SK: `PAYMENT#${iso}#${paymentId}`,
  }),
  /** Legacy confirm-link row, keyed by the raw token (links sent before hashing). */
  token: (token: string) => ({ PK: `TOKEN#${token}`, SK: 'TOKEN' }),
  /** Confirm-link row keyed by sha256(token): the table never holds a usable token. */
  tokenHash: (sha: string) => ({ PK: `TOKENH#${sha}`, SK: 'TOKEN' }),
};

export const gsi = {
  playerList: () => ({ GSI1PK: 'PLAYER' }),
  adminList: () => ({ GSI1PK: 'ADMIN' }),
  paymentStatus: (status: string) => ({ GSI1PK: `PAYMENT_STATUS#${status}` }),
  kioskList: () => ({ GSI1PK: 'KIOSK' }),
};
