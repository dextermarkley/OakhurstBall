// Club expenses (admins only): basketballs, insurance, the monthly facility fee,
// and anything else. Reported per club season (Apr 1 – Mar 31) next to the
// payments the club received in the same season.
//
//   PK=EXPENSE  SK=EXP#<YYYY-MM-DD>#<id>
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1 } from './ddb.js';
import { newId } from './crypto.js';
import { clubDate } from './repo.js';
import { clubYear } from './plans.js';

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return { error: 'date must be YYYY-MM-DD' };
  // Real calendar date (rejects 2026-02-30) and not in a far-off year.
  const d = new Date(`${date}T12:00:00Z`);
  if (d.toISOString().slice(0, 10) !== date) return { error: 'date must be a real date' };
  const yearsAway = Math.abs(Number(date.slice(0, 4)) - Number(today.slice(0, 4)));
  if (yearsAway > 5) return { error: 'date is too far from today' };
  if (date > addDays(today, 31)) return { error: 'date can’t be more than a month ahead' };
  const category = String(b?.category ?? '') as Category;
  if (!CATEGORIES.includes(category)) return { error: `category must be one of ${CATEGORIES.join(', ')}` };
  const amountCents = Number(b?.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { error: 'amount must be more than $0' };
  if (amountCents > MAX_EXPENSE_CENTS) return { error: 'amount is too large' };
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

/** Everything the Expenses tab shows for one season. */
export async function expenseReport(season?: number) {
  const today = clubDate();
  const current = clubYear(today);
  const cy = season ?? current;
  const { start, end } = seasonRange(cy);
  const [expenses, incomeCents, last] = await Promise.all([listExpenses(start, end), incomeBetween(start, end), lastAmounts()]);
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  let totalCents = 0;
  for (const e of expenses) {
    byCategory[e.category] += e.amountCents;
    totalCents += e.amountCents;
  }
  const month = today.slice(0, 7);
  const monthCents = expenses.filter((e) => e.date.startsWith(month)).reduce((s, e) => s + e.amountCents, 0);
  return {
    season: { year: cy, label: seasonLabel(cy), start, end, current: cy === current },
    seasons: Array.from({ length: Math.max(1, current - 2025 + 1) }, (_, i) => current - i)
      .filter((y) => y >= 2025)
      .map((y) => ({ year: y, label: seasonLabel(y) })),
    today,
    expenses,
    totalCents,
    byCategory,
    incomeCents,
    monthCents,
    facilityThisMonth: cy === current ? expenses.some((e) => e.category === 'facility' && e.date.startsWith(month)) : null,
    lastAmounts: last,
  };
}
