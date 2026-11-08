// Session announcements ("Ball today OCI - 5:30") with RSVPs.
//
// One announcement is current at a time and only for the club day it was posted
// (it disappears at local midnight). Posting a new one replaces it and starts the
// RSVPs fresh; editing keeps them.
//
//   PK=CURRENT    SK=ANNOUNCE   pointer { announceId, date }
//   PK=ANN#<id>   SK=META       the announcement
//   PK=ANN#<id>   SK=RSVP#<playerId>  { playerId, name, status: in|out, at }
import { DeleteCommand, PutCommand, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from './ddb.js';
import { queryAll } from './page.js';
import { newId } from './crypto.js';
import { clubDate } from './repo.js';

export const DEFAULT_ANNOUNCEMENT = 'Ball today OCI - 5:30';
export const MAX_ANNOUNCEMENT = 280;

export type RsvpStatus = 'in' | 'maybe' | 'out';
export interface Rsvp {
  playerId: string;
  name: string;
  status: RsvpStatus;
  at: string;
}
export interface Announcement {
  announceId: string;
  text: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  createdByName: string;
  createdBySub: string;
}

const POINTER = { PK: 'CURRENT', SK: 'ANNOUNCE' };
const meta = (id: string) => ({ PK: `ANN#${id}`, SK: 'META' });
const rsvpKey = (id: string, playerId: string) => ({ PK: `ANN#${id}`, SK: `RSVP#${playerId}` });

/** Today's announcement with its RSVPs, or null. */
export async function currentAnnouncement(): Promise<(Announcement & { rsvps: Rsvp[] }) | null> {
  const ptr = (await ddb.send(new GetCommand({ TableName: TABLE, Key: POINTER }))).Item;
  if (!ptr || ptr.date !== clubDate()) return null;
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `ANN#${ptr.announceId}` },
  });
  const m = items.find((i) => i.SK === 'META');
  if (!m) return null;
  const rsvps = items
    .filter((i) => String(i.SK).startsWith('RSVP#'))
    .map((i) => ({ playerId: i.playerId, name: i.name, status: i.status, at: i.at }) as Rsvp)
    .sort((a, b) => a.at.localeCompare(b.at));
  return {
    announceId: m.announceId,
    text: m.text,
    date: m.date,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    createdByName: m.createdByName,
    createdBySub: m.createdBySub,
    rsvps,
  };
}

export function cleanText(raw: unknown): string | null {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_ANNOUNCEMENT) return null;
  return t;
}

export async function postAnnouncement(text: string, by: { sub: string; name: string }): Promise<Announcement> {
  const now = new Date().toISOString();
  const a: Announcement = {
    announceId: newId(),
    text,
    date: clubDate(),
    createdAt: now,
    updatedAt: now,
    createdByName: by.name,
    createdBySub: by.sub,
  };
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...meta(a.announceId), ...a } } },
        { Put: { TableName: TABLE, Item: { ...POINTER, announceId: a.announceId, date: a.date } } },
      ],
    }),
  );
  return a;
}

/** Edit today's announcement in place. False if it isn't current any more. */
export async function editAnnouncement(announceId: string, text: string): Promise<boolean> {
  const cur = await currentAnnouncement();
  if (!cur || cur.announceId !== announceId) return false;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: meta(announceId),
      UpdateExpression: 'SET #t = :t, updatedAt = :now',
      ExpressionAttributeNames: { '#t': 'text' },
      ExpressionAttributeValues: { ':t': text, ':now': new Date().toISOString() },
    }),
  );
  return true;
}

/** Take it down (history is kept). */
export async function removeAnnouncement(announceId: string): Promise<boolean> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: POINTER,
        ConditionExpression: 'announceId = :id',
        ExpressionAttributeValues: { ':id': announceId },
      }),
    );
    return true;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Set (or clear, with null) a player's RSVP on today's announcement. */
export async function setRsvp(
  announceId: string,
  player: { playerId: string; name: string },
  status: RsvpStatus | null,
): Promise<boolean> {
  const cur = await currentAnnouncement();
  if (!cur || cur.announceId !== announceId) return false;
  if (status === null) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: rsvpKey(announceId, player.playerId) }));
  } else {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ...rsvpKey(announceId, player.playerId),
          playerId: player.playerId,
          name: player.name,
          status,
          at: new Date().toISOString(),
        },
      }),
    );
  }
  return true;
}
