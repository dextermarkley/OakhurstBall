// Period passes (quarter / year). One item per player per period:
//   PLAYER#<pid> / PASS#<periodId>   GSI1PK = PASS#<periodId>, GSI1SK = <pid>
// The GSI lets the Admin page list everyone holding the current quarter/year pass.
import { BatchGetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1 } from './ddb.js';
import { queryAll } from './page.js';
import { periodFor, clubQuarter, PLAN_PRICES, type Period, type Plan } from './plans.js';
import { clubDate } from './repo.js';

export interface Pass {
  playerId: string;
  plan: Plan;
  periodId: string;
  label: string;
  start: string;
  end: string;
  amountCents: number;
  source: 'card' | 'cash' | 'admin';
  paymentId?: string;
  grantedBy?: string;
  createdAt: string;
}

export const passKey = (playerId: string, periodId: string) => ({
  PK: `PLAYER#${playerId}`,
  SK: `PASS#${periodId}`,
});

/** The full item to Put for a pass (used inside payment-settle transactions too). */
export function passItem(p: Omit<Pass, 'createdAt'> & { createdAt?: string }) {
  return {
    ...passKey(p.playerId, p.periodId),
    ...p,
    createdAt: p.createdAt ?? new Date().toISOString(),
    GSI1PK: `PASS#${p.periodId}`,
    GSI1SK: p.playerId,
  };
}

/** The pass that covers `date` for this player (year beats quarter), or null. */
export async function coveringPass(playerId: string, date = clubDate()): Promise<Pass | null> {
  const ids = [periodFor('year', date).periodId, periodFor('quarter', date).periodId];
  const r = await ddb.send(
    new BatchGetCommand({
      RequestItems: { [TABLE]: { Keys: ids.map((id) => passKey(playerId, id)), ConsistentRead: true } },
    }),
  );
  const items = (r.Responses?.[TABLE] ?? []) as Pass[];
  return items.find((p) => p.plan === 'year') ?? items.find((p) => p.plan === 'quarter') ?? null;
}

/**
 * The year pass is only sold during Q1 (Apr 1 – Jun 30). After that, the
 * remaining quarters cost less than $320 bought one at a time.
 */
export const yearPassOnSale = (date = clubDate()) => clubQuarter(date) === 1;

export type OfferStatus = 'available' | 'owned' | 'not_offered';

/** What a player can buy right now, given what already covers them. */
export function purchasable(current: Pass | null, date = clubDate()) {
  const offer = (plan: Plan) => {
    const period: Period = periodFor(plan, date);
    const owned =
      current?.plan === 'year' || (plan === 'quarter' && current?.periodId === period.periodId);
    const status: OfferStatus = owned
      ? 'owned'
      : plan === 'year' && !yearPassOnSale(date)
        ? 'not_offered'
        : 'available';
    return {
      plan,
      priceCents: PLAN_PRICES[plan],
      label: period.label,
      end: period.end,
      status,
      available: status === 'available',
    };
  };
  return [offer('quarter'), offer('year')];
}

/** player ids holding a pass for the period containing `date`, keyed by plan. */
export async function currentPassHolders(date = clubDate()): Promise<Map<string, Pass>> {
  const out = new Map<string, Pass>();
  for (const plan of ['quarter', 'year'] as const) {
    const holders = await queryAll<Pass>({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `PASS#${periodFor(plan, date).periodId}` },
    });
    for (const p of holders) {
      if (plan === 'year' || !out.has(p.playerId)) out.set(p.playerId, p); // year wins
    }
  }
  return out;
}

/** Admin records a pass paid outside the app. Fails if it already exists. */
export async function grantPass(playerId: string, plan: Plan, grantedBy: string): Promise<Pass | null> {
  const period = periodFor(plan, clubDate());
  const item = passItem({
    playerId,
    plan,
    periodId: period.periodId,
    label: period.label,
    start: period.start,
    end: period.end,
    amountCents: PLAN_PRICES[plan],
    source: 'admin',
    grantedBy,
  });
  try {
    await ddb.send(
      new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }),
    );
    return item as Pass;
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

/** A player's passes, newest first. */
export async function playerPasses(playerId: string): Promise<Pass[]> {
  const passes = await queryAll<Pass>({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':sk': 'PASS#' },
  });
  return passes.sort((a, b) => b.start.localeCompare(a.start));
}
