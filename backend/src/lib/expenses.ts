// Club expenses (admins only): basketballs, insurance, the monthly facility fee,
// and anything else. Reported per club season (Apr 1 – Mar 31) next to the
// payments the club received in the same season.
//
//   PK=EXPENSE  SK=EXP#<YYYY-MM-DD>#<id>
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1 } from './ddb.js';
import { newId } from './crypto.js';
import { clubDate } from './repo.js';
import { clubYear, periodFor } from './plans.js';
import { queryAll } from './page.js';
import type { Pass } from './passes.js';

export const CATEGORIES = ['basketballs', 'insurance', 'facility', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const MAX_EXPENSE_CENTS = 10_000_000; // $100,000: a typo guard, not a policy

export interface Expense {
  expenseId: string;
  cursor: string;
  date: string;
  category: Category;
  amountCents: number;
  note?: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseInput {
  date: string;
  category: Category;
  amountCents: number;
  note?: string;
}

/** Validate an expense from the API. Returns the clean input or an error message. */
export function checkExpense(b: any, today: string): { input?: ExpenseInput; error?: string } {
  const date = String(b?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return { error: 'Enter the date as YYYY-MM-DD' };
  // Real calendar date (rejects 2026-02-30) and not in a far-off year.
  const d = new Date(`${date}T12:00:00Z`);
  if (d.toISOString().slice(0, 10) !== date) return { error: 'date must be a real date' };
  const yearsAway = Math.abs(Number(date.slice(0, 4)) - Number(today.slice(0, 4)));
  if (yearsAway > 5) return { error: 'date is too far from today' };
  if (date > addDays(today, 31)) return { error: 'date can’t be more than a month ahead' };
  const category = String(b?.category ?? '') as Category;
  if (!CATEGORIES.includes(category)) return { error: 'Pick a category' };
  const amountCents = Number(b?.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { error: 'amount must be more than $0' };
  if (amountCents > MAX_EXPENSE_CENTS) return { error: 'Amount can’t be more than $100,000' };
  const note = String(b?.note ?? '').replace(/\s+/g, ' ').trim();
  if (note.length > 200) return { error: 'note must be 200 characters or fewer' };
  return { input: { date, category, amountCents, note: note || undefined } };
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Season named by the year it starts in: 2026 = 2026-04-01 … 2027-03-31. */
export const seasonRange = (cy: number) => ({ start: `${cy}-04-01`, end: `${cy + 1}-03-31` });
export const seasonLabel = (cy: number) => `${cy}–${String((cy + 1) % 100).padStart(2, '0')} season`;

const view = (i: any): Expense => ({
  expenseId: i.expenseId,
  cursor: i.SK,
  date: i.date,
  category: i.category,
  amountCents: i.amountCents,
  note: i.note,
  createdByName: i.createdByName,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
});

export async function listExpenses(from: string, to: string): Promise<Expense[]> {
  const out: Expense[] = [];
  let start: Record<string, any> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': 'EXPENSE', ':a': `EXP#${from}`, ':b': `EXP#${to}#\uffff` },
        ScanIndexForward: false,
        ExclusiveStartKey: start,
      }),
    );
    out.push(...(r.Items ?? []).map(view));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

/** Most recent amount per category, to prefill the next one (e.g. the monthly facility fee). */
export async function lastAmounts(): Promise<Partial<Record<Category, number>>> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':pk': 'EXPENSE', ':s': 'EXP#' },
      ScanIndexForward: false,
      Limit: 200,
    }),
  );
  const out: Partial<Record<Category, number>> = {};
  for (const i of r.Items ?? []) if (out[i.category as Category] == null) out[i.category as Category] = i.amountCents;
  return out;
}

export async function addExpense(input: ExpenseInput, by: { sub: string; name: string }): Promise<Expense> {
  const now = new Date().toISOString();
  const expenseId = newId();
  const item = {
    PK: 'EXPENSE',
    SK: `EXP#${input.date}#${expenseId}`,
    expenseId,
    ...input,
    createdBySub: by.sub,
    createdByName: by.name,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return view(item);
}

const CURSOR_RE = /^EXP#\d{4}-\d{2}-\d{2}#[a-f0-9]{24}$/;

/** Edit in place; a new date moves it (the date is part of the key). */
export async function updateExpense(cursor: string, input: ExpenseInput): Promise<Expense | null> {
  if (!CURSOR_RE.test(cursor)) return null;
  const cur = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'EXPENSE', SK: cursor } }))).Item;
  if (!cur) return null;
  const next = { ...cur, ...input, note: input.note, updatedAt: new Date().toISOString(), SK: `EXP#${input.date}#${cur.expenseId}` };
  if (next.SK === cursor) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: next, ConditionExpression: 'attribute_exists(PK)' }));
  } else {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: TABLE, Key: { PK: 'EXPENSE', SK: cursor }, ConditionExpression: 'attribute_exists(PK)' } },
          { Put: { TableName: TABLE, Item: next } },
        ],
      }),
    );
  }
  return view(next);
}

export async function deleteExpense(cursor: string): Promise<boolean> {
  if (!CURSOR_RE.test(cursor)) return false;
  const r = await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'EXPENSE', SK: cursor }, ReturnValues: 'ALL_OLD' }));
  return !!r.Attributes;
}

/** Confirmed payments (card + cash) made on club dates within [from, to]. */
export async function incomeBetween(from: string, to: string): Promise<number> {
  // GSI1SK is the payment's UTC timestamp; widen by a day each side, then filter
  // on the club-local date so the season edges are exact.
  const lo = `${addDays(from, -1)}T00:00:00.000Z`;
  const hi = `${addDays(to, 1)}T23:59:59.999Z`;
  let total = 0;
  let start: Record<string, any> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: { ':pk': 'PAYMENT_STATUS#confirmed', ':lo': lo, ':hi': hi },
        ExclusiveStartKey: start,
      }),
    );
    for (const p of r.Items ?? []) {
      const d = clubDate(new Date(p.createdAt));
      if (d >= from && d <= to) total += p.amountCents ?? 0;
    }
    start = r.LastEvaluatedKey;
  } while (start);
  return total;
}

/**
 * What admin-granted passes are worth to a period, for the "count granted
 * passes" view. No money moved for these, so they never count as real income.
 * A quarter pass counts its price in its own quarter. A year pass counts a
 * quarter of its price in each quarter, so all of it in the whole-season view.
 */
export function grantedShare(passes: Array<{ plan: string; amountCents: number; source: string }>, wholeSeason: boolean) {
  let cents = 0;
  let yearPasses = 0;
  let quarterPasses = 0;
  for (const p of passes) {
    if (p.source !== 'admin') continue;
    if (p.plan === 'year') {
      yearPasses++;
      cents += wholeSeason ? p.amountCents : Math.round(p.amountCents / 4);
    } else if (p.plan === 'quarter') {
      quarterPasses++;
      cents += p.amountCents;
    }
  }
  return { cents, yearPasses, quarterPasses };
}

/** Admin-granted passes for a season, or for one quarter plus the season's year passes. */
async function grantedPasses(cy: number, quarter?: 1 | 2 | 3 | 4) {
  const ids = [
    periodFor('year', seasonRange(cy).start).periodId,
    ...(quarter ? [quarter] : ([1, 2, 3, 4] as const)).map((q) => periodFor('quarter', quarterRange(cy, q).start).periodId),
  ];
  const lists = await Promise.all(
    ids.map((id) =>
      queryAll<Pass>({
        TableName: TABLE,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `PASS#${id}` },
      }),
    ),
  );
  return grantedShare(lists.flat(), !quarter);
}

/** Club quarter q (1–4) of club year cy: Q1 Apr–Jun … Q4 Jan–Mar. */
export function quarterRange(cy: number, q: 1 | 2 | 3 | 4) {
  const startMonth = [4, 7, 10, 1][q - 1];
  const y = q === 4 ? cy + 1 : cy;
  const p = periodFor('quarter', `${y}-${String(startMonth).padStart(2, '0')}-01`);
  return { start: p.start, end: p.end, label: p.label };
}

/** A season's report, or one quarter of it. */
export async function expenseReport(season?: number, quarter?: 1 | 2 | 3 | 4) {
  const today = clubDate();
  const current = clubYear(today);
  const cy = season ?? current;
  const range = quarter ? quarterRange(cy, quarter) : { ...seasonRange(cy), label: seasonLabel(cy) };
  const { start, end } = range;
  const [expenses, incomeCents, granted, last] = await Promise.all([
    listExpenses(start, end),
    incomeBetween(start, end),
    grantedPasses(cy, quarter),
    lastAmounts(),
  ]);
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  let totalCents = 0;
  for (const e of expenses) {
    byCategory[e.category] += e.amountCents;
    totalCents += e.amountCents;
  }
  const month = today.slice(0, 7);
  const monthCents = expenses.filter((e) => e.date.startsWith(month)).reduce((s, e) => s + e.amountCents, 0);
  return {
    season: { year: cy, label: seasonLabel(cy), ...seasonRange(cy), current: cy === current },
    /** What the totals cover: the whole season, or one quarter of it. */
    period: {
      quarter: quarter ?? null,
      label: range.label,
      start,
      end,
      current: today >= start && today <= end,
    },
    /** Quarters of this season that have started (for the picker). */
    quarters: ([1, 2, 3, 4] as const)
      .map((q) => ({ quarter: q, ...quarterRange(cy, q) }))
      .filter((q) => q.start <= today)
      .map((q) => ({ quarter: q.quarter, label: q.label })),
    seasons: Array.from({ length: Math.max(1, current - 2025 + 1) }, (_, i) => current - i)
      .filter((y) => y >= 2025)
      .map((y) => ({ year: y, label: seasonLabel(y) })),
    today,
    expenses,
    totalCents,
    byCategory,
    incomeCents,
    /** Admin-granted passes credited to this period (not real income). */
    granted,
    monthCents,
    facilityThisMonth: today >= start && today <= end ? expenses.some((e) => e.category === 'facility' && e.date.startsWith(month)) : null,
    lastAmounts: last,
  };
}
