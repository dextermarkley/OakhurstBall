// Gym sessions. An admin opens the gym; players check in (kiosk or player page)
// only while a session is open. A session closes when an admin closes it or
// SESSION_HOURS after it opened, whichever is first. The time limit needs no
// scheduler: "open" always means "not closed and closesAt still in the future".
//
// Items:
//   CURRENT / SESSION              pointer to the latest session (guards "one open at a time")
//   SESSION#<id> / META            the session; GSI1PK=SESSION for the history list
//   SESSION#<id> / ATTEND#<pid>    one per attendee (its condition = once per session)
//   PLAYER#<pid> / CHECKIN#<iso>   the player's own attendance history
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1, keys } from './ddb.js';
import { newId } from './crypto.js';
import { clubDate, getPlayer } from './repo.js';
import { coveringPass, type Pass } from './passes.js';

const num = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
export const SESSION_HOURS = num('SESSION_HOURS', 5);
/** How far below $0 check-in fees may take a balance. */
export const NEGATIVE_LIMIT_CENTS = num('NEGATIVE_LIMIT_CENTS', 1000);

const POINTER = { PK: 'CURRENT', SK: 'SESSION' };
const metaKey = (sid: string) => ({ PK: `SESSION#${sid}`, SK: 'META' });
const attendKey = (sid: string, pid: string) => ({ PK: `SESSION#${sid}`, SK: `ATTEND#${pid}` });

export interface Session {
  sessionId: string;
  eventDate: string; // club-local date the session opened
  openedAt: string;
  closesAt: string; // automatic close time
  closedAt?: string; // set when an admin closes it early
  openedByName: string;
  attendeeCount: number;
}

export interface Attendee {
  playerId: string;
  name: string;
  at: string;
  feeCents: number;
  source: 'kiosk' | 'player';
  coveredBy?: 'quarter' | 'year';
}

const nowIso = () => new Date().toISOString();
export const isOpen = (s: Session, now = nowIso()) => !s.closedAt && s.closesAt > now;

/** When the session actually ended (admin close, or the automatic time limit). */
export function endedAt(s: Session, now = nowIso()): string | null {
  if (s.closedAt) return s.closedAt;
  return s.closesAt <= now ? s.closesAt : null;
}

const toSession = (i: any): Session => ({
  sessionId: i.sessionId,
  eventDate: i.eventDate,
  openedAt: i.openedAt,
  closesAt: i.closesAt,
  closedAt: i.closedAt,
  openedByName: i.openedByName,
  attendeeCount: i.attendeeCount ?? 0,
});

export async function getSession(sessionId: string): Promise<Session | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: metaKey(sessionId) }));
  return r.Item ? toSession(r.Item) : null;
}

export async function currentSession(): Promise<Session | null> {
  const p = await ddb.send(new GetCommand({ TableName: TABLE, Key: POINTER }));
  const ptr = p.Item as any;
  if (!ptr || ptr.closedAt || ptr.closesAt <= nowIso()) return null;
  const s = await getSession(ptr.sessionId);
  return s && isOpen(s) ? s : null;
}

/** Open a session. Returns null if one is already open. */
export async function openSession(openedByName: string): Promise<Session | null> {
  const opened = new Date();
  const s: Session = {
    sessionId: newId(),
    eventDate: clubDate(opened),
    openedAt: opened.toISOString(),
    closesAt: new Date(opened.getTime() + SESSION_HOURS * 3_600_000).toISOString(),
    openedByName,
    attendeeCount: 0,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { ...POINTER, sessionId: s.sessionId, closesAt: s.closesAt },
              ConditionExpression:
                'attribute_not_exists(PK) OR attribute_exists(closedAt) OR closesAt <= :now',
              ExpressionAttributeValues: { ':now': s.openedAt },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: { ...metaKey(s.sessionId), ...s, GSI1PK: 'SESSION', GSI1SK: s.openedAt },
            },
          },
        ],
      }),
    );
    return s;
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') return null;
    throw err;
  }
}

export async function closeSession(sessionId: string): Promise<'closed' | 'already' | 'notfound'> {
  const s = await getSession(sessionId);
  if (!s) return 'notfound';
  if (!isOpen(s)) return 'already';
  const now = nowIso();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: metaKey(sessionId),
              UpdateExpression: 'SET closedAt = :now',
              ConditionExpression: 'attribute_not_exists(closedAt)',
              ExpressionAttributeValues: { ':now': now },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: POINTER,
              UpdateExpression: 'SET closedAt = :now',
              ConditionExpression: 'sessionId = :sid',
              ExpressionAttributeValues: { ':now': now, ':sid': sessionId },
            },
          },
        ],
      }),
    );
    return 'closed';
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') return 'already';
    throw err;
  }
}

/** All sessions, newest first. */
export async function listSessions(limit = 200): Promise<Session[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'SESSION' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (r.Items ?? []).map(toSession);
}

export async function sessionAttendees(sessionId: string): Promise<Attendee[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}`, ':sk': 'ATTEND#' },
    }),
  );
  return (r.Items ?? [])
    .map((i: any) => ({
      playerId: i.playerId,
      name: i.name,
      at: i.at,
      feeCents: i.feeCents ?? 0,
      source: i.source,
      coveredBy: i.coveredBy,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export async function isCheckedIn(sessionId: string, playerId: string): Promise<boolean> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: attendKey(sessionId, playerId) }));
  return !!r.Item;
}

export type CheckInResult =
  | {
      result: 'checked_in' | 'already';
      session: Session;
      feeCents: number;
      balanceCents: number;
      pass: Pass | null;
    }
  | { result: 'no_session' }
  /** mode 'auto' only: credit doesn't cover the fee, but they may defer ("pay next time"). Not checked in. */
  | { result: 'needs_payment'; session: Session; balanceCents: number; minBalanceCents: number; pass: null }
  | { result: 'limit'; session: Session; balanceCents: number; minBalanceCents: number; pass: null };

/**
 * 'auto'  — check in only if a pass covers the session or the balance covers the
 *           fee; otherwise return needs_payment (allowed to defer) or limit.
 * 'defer' — check in and let the balance go negative, down to the limit
 *           ("pay next time", or after choosing a payment method).
 */
export type CheckInMode = 'auto' | 'defer';

/**
 * Check a player into the open session and charge the fee, in one transaction:
 *   0. session must still be open (and its attendee count goes up)
 *   1. attendee row must not exist yet  → once per session, no double charge
 *   2. balance after the fee must stay ≥ −NEGATIVE_LIMIT_CENTS
 *   3. player attendance history row
 * Any failed condition cancels everything; the cancellation reasons say which.
 */
export async function sessionCheckIn(
  player: { playerId: string; name: string },
  feeCents: number,
  source: 'kiosk' | 'player',
  mode: CheckInMode = 'defer',
): Promise<CheckInResult> {
  const session = await currentSession();
  if (!session) return { result: 'no_session' };
  // A quarter/year pass covering the session's date makes check-in free, and the
  // negative-balance limit does not apply (the period is paid for).
  const pass = await coveringPass(player.playerId, session.eventDate);
  if (pass) feeCents = 0;
  const at = nowIso();
  // Lowest balance (before the fee) that may still defer payment.
  const limitMin = feeCents - NEGATIVE_LIMIT_CENTS;
  // In auto mode the balance must cover the fee outright.
  const minBalanceCents = mode === 'auto' ? feeCents : limitMin;
  const balanceCondition = pass ? 'attribute_exists(PK)' : 'attribute_exists(PK) AND balanceCents >= :min';
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: metaKey(session.sessionId),
              UpdateExpression: 'ADD attendeeCount :one',
              ConditionExpression: 'attribute_not_exists(closedAt) AND closesAt > :now',
              ExpressionAttributeValues: { ':one': 1, ':now': at },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                ...attendKey(session.sessionId, player.playerId),
                playerId: player.playerId,
                name: player.name,
                at,
                feeCents,
                source,
                ...(pass ? { coveredBy: pass.plan } : {}),
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: keys.playerProfile(player.playerId),
              UpdateExpression: 'ADD balanceCents :fee SET updatedAt = :now',
              ConditionExpression: balanceCondition,
              ExpressionAttributeValues: {
                ':fee': -feeCents,
                ':now': at,
                ...(pass ? {} : { ':min': minBalanceCents }),
              },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `PLAYER#${player.playerId}`,
                SK: `CHECKIN#${at}`,
                playerId: player.playerId,
                sessionId: session.sessionId,
                eventDate: session.eventDate,
                at,
                source,
                feeCents,
                ...(pass ? { coveredBy: pass.plan } : {}),
              },
            },
          },
        ],
      }),
    );
  } catch (err: any) {
    if (err?.name !== 'TransactionCanceledException') throw err;
    const failed = (i: number) => err.CancellationReasons?.[i]?.Code === 'ConditionalCheckFailed';
    const balanceCents = (await getPlayer(player.playerId))?.balanceCents ?? 0;
    if (failed(0)) return { result: 'no_session' };
    if (failed(1)) return { result: 'already', session, feeCents: 0, balanceCents, pass };
    if (failed(2)) {
      const canDefer = mode === 'auto' && balanceCents >= limitMin;
      return { result: canDefer ? 'needs_payment' : 'limit', session, balanceCents, minBalanceCents: limitMin, pass: null };
    }
    throw err;
  }
  const balanceCents = (await getPlayer(player.playerId))?.balanceCents ?? 0;
  return {
    result: 'checked_in',
    session: { ...session, attendeeCount: session.attendeeCount + 1 },
    feeCents,
    balanceCents,
    pass,
  };
}

/**
 * A pass bought after checking in covers that session too: refund the fee the
 * player already paid for the open session if it falls inside the pass period.
 * Conditioned on the fee still being on the attendee row, so it refunds at most once.
 */
export async function refundCurrentSessionFee(
  playerId: string,
  pass: { plan: 'quarter' | 'year'; start: string; end: string },
): Promise<number> {
  const session = await currentSession();
  if (!session || session.eventDate < pass.start || session.eventDate > pass.end) return 0;
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: attendKey(session.sessionId, playerId) }));
  const fee = (r.Item as any)?.feeCents ?? 0;
  if (!fee) return 0;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: attendKey(session.sessionId, playerId),
              UpdateExpression: 'SET feeCents = :zero, coveredBy = :plan, refundedCents = :fee',
              ConditionExpression: 'feeCents = :fee',
              ExpressionAttributeValues: { ':zero': 0, ':plan': pass.plan, ':fee': fee },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: keys.playerProfile(playerId),
              UpdateExpression: 'ADD balanceCents :fee SET updatedAt = :now',
              ExpressionAttributeValues: { ':fee': fee, ':now': nowIso() },
            },
          },
        ],
      }),
    );
    return fee;
  } catch (err: any) {
    if (err?.name === 'TransactionCanceledException') return 0; // already refunded
    throw err;
  }
}
