// Club notices: plain messages from the admins ("Gym closed for the next 3
// weeks"). Unlike the session announcement there are no RSVPs, a notice can stay
// up for days or weeks (until the date the admin picks), and several can be up
// at once.
//
//   PK=NOTICE  SK=N#<id>   { noticeId, text, until (club date, inclusive), ... }
//   expiresAt (TTL) deletes it a few days after `until`.
import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from './ddb.js';
import { queryAll } from './page.js';
import { newId } from './crypto.js';
import { clubDate } from './repo.js';

export const MAX_NOTICE = 500;
/** Notices up at once, so the player page stays readable. */
export const MAX_ACTIVE_NOTICES = 5;
/** Longest a notice can stay up. */
export const MAX_NOTICE_DAYS = 180;

export interface Notice {
  noticeId: string;
  text: string;
  /** Last club day it shows (YYYY-MM-DD). */
  until: string;
  createdAt: string;
  updatedAt: string;
  createdByName: string;
}

const key = (id: string) => ({ PK: 'NOTICE', SK: `N#${id}` });
const YMD = /^\d{4}-\d\d-\d\d$/;

/** Days from a to b (YYYY-MM-DD), by calendar date. */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/** Validate notice input. Text keeps line breaks (a notice can be a short paragraph). */
export function checkNotice(b: any, today = clubDate()): { text?: string; until?: string; error?: string } {
  const text = String(typeof b?.text === 'string' ? b.text : '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // control and bidi-override characters (keep line breaks)
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return { error: 'Type the notice' };
  if (text.length > MAX_NOTICE) return { error: `Notices are limited to ${MAX_NOTICE} characters` };
  const until = typeof b?.until === 'string' ? b.until : '';
  if (!YMD.test(until) || Number.isNaN(Date.parse(until + 'T00:00:00Z'))) return { error: 'Pick the last day to show it' };
  if (until < today) return { error: 'The last day can’t be in the past' };
  if (daysBetween(today, until) > MAX_NOTICE_DAYS) return { error: `A notice can stay up for at most ${MAX_NOTICE_DAYS} days` };
  return { text, until };
}

const view = (i: any): Notice => ({
  noticeId: i.noticeId,
  text: i.text,
  until: i.until,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  createdByName: i.createdByName,
});

/** Notices showing today, newest first. */
export async function activeNotices(today = clubDate()): Promise<Notice[]> {
  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'NOTICE' },
  });
  return items
    .filter((i) => i.until >= today)
    .map(view)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const ttlFor = (until: string) => Math.floor(Date.parse(until + 'T00:00:00Z') / 1000) + 3 * 86400;

export async function postNotice(text: string, until: string, by: { sub: string; name: string }): Promise<Notice | 'full'> {
  if ((await activeNotices()).length >= MAX_ACTIVE_NOTICES) return 'full';
  const now = new Date().toISOString();
  const n: Notice = { noticeId: newId(), text, until, createdAt: now, updatedAt: now, createdByName: by.name };
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: { ...key(n.noticeId), ...n, createdBySub: by.sub, expiresAt: ttlFor(until) } }),
  );
  return n;
}

/** Change a notice's text or last day. Null if it doesn't exist. */
export async function editNotice(noticeId: string, text: string, until: string): Promise<Notice | null> {
  try {
    const r = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: key(noticeId),
        UpdateExpression: 'SET #t = :t, #u = :u, updatedAt = :now, expiresAt = :exp',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#t': 'text', '#u': 'until' },
        ExpressionAttributeValues: { ':t': text, ':u': until, ':now': new Date().toISOString(), ':exp': ttlFor(until) },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return view(r.Attributes);
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

export async function removeNotice(noticeId: string): Promise<boolean> {
  const r = await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key(noticeId), ReturnValues: 'ALL_OLD' }));
  return !!r.Attributes;
}
