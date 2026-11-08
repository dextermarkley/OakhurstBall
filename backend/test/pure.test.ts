// Pure-logic tests (no AWS, no network). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '../src/lib/stripe.js';
import { clubDate } from '../src/lib/repo.js';

const secret = 'whsec_test_secret';
const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
const sign = (t: number, payload = body, key = secret) =>
  createHmac('sha256', key).update(`${t}.${payload}`).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

test('webhook: valid Stripe signature is accepted', () => {
  const t = now();
  assert.equal(verifyWebhookSignature(body, `t=${t},v1=${sign(t)}`, secret), true);
});

test('webhook: accepted when one of several v1 signatures matches (key rotation)', () => {
  const t = now();
  assert.equal(verifyWebhookSignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${sign(t)}`, secret), true);
});

test('webhook: tampered body is rejected', () => {
  const t = now();
  assert.equal(verifyWebhookSignature(body + ' ', `t=${t},v1=${sign(t)}`, secret), false);
});

test('webhook: wrong secret is rejected', () => {
  const t = now();
  assert.equal(verifyWebhookSignature(body, `t=${t},v1=${sign(t, body, 'whsec_other')}`, secret), false);
});

test('webhook: replayed signature older than 5 minutes is rejected', () => {
  const t = now() - 301;
  assert.equal(verifyWebhookSignature(body, `t=${t},v1=${sign(t)}`, secret), false);
});

test('webhook: malformed header is rejected', () => {
  assert.equal(verifyWebhookSignature(body, 'garbage', secret), false);
  assert.equal(verifyWebhookSignature(body, '', secret), false);
});

test('clubDate: the day rolls over at Pacific midnight, not UTC midnight', () => {
  process.env.CLUB_TZ = 'America/Los_Angeles';
  // 2026-11-06 06:30 UTC = 2026-11-05 22:30 PST → still the 5th at the club.
  assert.equal(clubDate(new Date('2026-11-06T06:30:00Z')), '2026-11-05');
  // 2026-11-06 08:30 UTC = 2026-11-06 00:30 PST → the 6th.
  assert.equal(clubDate(new Date('2026-11-06T08:30:00Z')), '2026-11-06');
  // Summer (PDT, UTC-7): 2026-07-01 06:59 UTC = 2026-06-30 23:59 PDT.
  assert.equal(clubDate(new Date('2026-07-01T06:59:00Z')), '2026-06-30');
});

// ── Club periods: year starts April 1, quarters every 3 months ──
import { periodFor, clubYear, clubQuarter } from '../src/lib/plans.js';

test('club year starts April 1 (Mar 31 is still the previous year)', () => {
  assert.equal(clubYear('2026-03-31'), 2025);
  assert.equal(clubYear('2026-04-01'), 2026);
  assert.equal(clubYear('2026-12-31'), 2026);
  assert.equal(clubYear('2027-01-01'), 2026);
  assert.equal(clubYear('2027-03-31'), 2026);
});

test('quarters restart Apr 1, Jul 1, Oct 1, Jan 1', () => {
  const cases: Array<[string, number, string, string]> = [
    ['2026-04-01', 1, '2026-04-01', '2026-06-30'],
    ['2026-06-30', 1, '2026-04-01', '2026-06-30'],
    ['2026-07-01', 2, '2026-07-01', '2026-09-30'],
    ['2026-09-30', 2, '2026-07-01', '2026-09-30'],
    ['2026-10-01', 3, '2026-10-01', '2026-12-31'],
    ['2026-12-31', 3, '2026-10-01', '2026-12-31'],
    ['2027-01-01', 4, '2027-01-01', '2027-03-31'],
    ['2027-03-31', 4, '2027-01-01', '2027-03-31'],
  ];
  for (const [date, q, start, end] of cases) {
    assert.equal(clubQuarter(date), q, date);
    const p = periodFor('quarter', date);
    assert.equal(p.start, start, date);
    assert.equal(p.end, end, date);
    assert.equal(p.periodId, `Q2026-${q}`, date);
  }
});

test('every day of a club year maps to exactly one quarter, in order, no gaps', () => {
  const seen: string[] = [];
  for (let t = Date.UTC(2026, 3, 1); t <= Date.UTC(2027, 2, 31); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const p = periodFor('quarter', d);
    assert.ok(p.start <= d && d <= p.end, d);
    if (seen.at(-1) !== p.periodId) seen.push(p.periodId);
  }
  assert.deepEqual(seen, ['Q2026-1', 'Q2026-2', 'Q2026-3', 'Q2026-4']);
});

test('Q4 spans a leap February correctly', () => {
  assert.equal(periodFor('quarter', '2028-02-29').end, '2028-03-31');
  assert.equal(periodFor('quarter', '2028-02-29').periodId, 'Q2027-4');
});

test('year pass covers Apr 1 – Mar 31 with readable labels', () => {
  const y = periodFor('year', '2027-02-10');
  assert.deepEqual([y.periodId, y.start, y.end, y.label], ['Y2026', '2026-04-01', '2027-03-31', '2026–27 season']);
  assert.equal(periodFor('quarter', '2026-11-05').label, 'Q3 2026–27 (Oct 1 – Dec 31)');
});

// ── Year pass is only sold in Q1 ──
import { purchasable, yearPassOnSale } from '../src/lib/passes.js';

test('year pass is on sale Apr 1 – Jun 30 only', () => {
  for (const d of ['2026-04-01', '2026-05-15', '2026-06-30']) assert.equal(yearPassOnSale(d), true, d);
  for (const d of ['2026-07-01', '2026-11-07', '2027-01-01', '2027-03-31']) assert.equal(yearPassOnSale(d), false, d);
});

test('offers: year shown in Q1, hidden after; quarter always (unless owned)', () => {
  const year = (d: string) => purchasable(null, d).find((o) => o.plan === 'year')!;
  const quarter = (d: string) => purchasable(null, d).find((o) => o.plan === 'quarter')!;
  assert.equal(year('2026-06-30').status, 'available');
  assert.equal(year('2026-07-01').status, 'not_offered');
  assert.equal(year('2026-07-01').available, false);
  assert.equal(quarter('2026-07-01').status, 'available');
  const qPass: any = { plan: 'quarter', periodId: 'Q2026-2' };
  assert.equal(purchasable(qPass, '2026-08-01').find((o) => o.plan === 'quarter')!.status, 'owned');
  const yPass: any = { plan: 'year', periodId: 'Y2026' };
  assert.equal(purchasable(yPass, '2026-05-01').find((o) => o.plan === 'year')!.status, 'owned');
});

// ── Expenses: input validation + season range ──
import { checkExpense, seasonRange, seasonLabel } from '../src/lib/expenses.js';

test('expense: a normal facility payment is accepted and the note is tidied', () => {
  const r = checkExpense({ date: '2026-11-01', category: 'facility', amountCents: 25000, note: '  Nov   court rental ' }, '2026-11-07');
  assert.deepEqual(r.input, { date: '2026-11-01', category: 'facility', amountCents: 25000, note: 'Nov court rental' });
});

test('expense: bad input is rejected', () => {
  const today = '2026-11-07';
  const ok = { date: '2026-11-01', category: 'basketballs', amountCents: 6000 };
  assert.ok(checkExpense({ ...ok, date: '2026-02-30' }, today).error, 'not a real date');
  assert.ok(checkExpense({ ...ok, date: '11/01/2026' }, today).error, 'wrong format');
  assert.ok(checkExpense({ ...ok, date: '2027-01-15' }, today).error, 'more than a month ahead');
  assert.ok(checkExpense({ ...ok, category: 'snacks' }, today).error, 'unknown category');
  assert.ok(checkExpense({ ...ok, amountCents: 0 }, today).error, 'zero');
  assert.ok(checkExpense({ ...ok, amountCents: -500 }, today).error, 'negative');
  assert.ok(checkExpense({ ...ok, amountCents: 12.5 }, today).error, 'fractional cents');
  assert.ok(checkExpense({ ...ok, amountCents: 10_000_001 }, today).error, 'over $100k');
  assert.ok(checkExpense({ ...ok, note: 'x'.repeat(201) }, today).error, 'note too long');
  assert.equal(checkExpense({ ...ok }, today).error, undefined);
});

test('expense seasons run Apr 1 – Mar 31', () => {
  assert.deepEqual(seasonRange(2026), { start: '2026-04-01', end: '2027-03-31' });
  assert.equal(seasonLabel(2026), '2026–27 season');
});

// ── Waiver + rules signature validation ──
import { checkSignature, isCurrent, WAIVER, RULES } from '../src/lib/agreements.js';

const goodSig = {
  waiverVersion: WAIVER.version,
  rulesVersion: RULES.version,
  agreeRules: true,
  agreeWaiver: true,
  signedName: '  Jordan   Ellis ',
  adult: true,
};

test('signature: an adult signing both is accepted, name tidied', () => {
  assert.deepEqual(checkSignature(goodSig).sig, { signedName: 'Jordan Ellis', adult: true, guardianName: undefined });
});

test('signature: a minor needs a guardian name', () => {
  assert.ok(checkSignature({ ...goodSig, adult: false }).error);
  assert.deepEqual(checkSignature({ ...goodSig, adult: false, guardianName: 'Pat Ellis' }).sig?.guardianName, 'Pat Ellis');
});

test('signature: missing pieces are rejected', () => {
  assert.ok(checkSignature({ ...goodSig, agreeRules: false }).error, 'rules not acknowledged');
  assert.ok(checkSignature({ ...goodSig, agreeWaiver: 'yes' }).error, 'waiver not agreed');
  assert.ok(checkSignature({ ...goodSig, signedName: 'Jordan' }).error, 'first name only');
  assert.ok(checkSignature({ ...goodSig, waiverVersion: '2020-01-01' }).error, 'stale waiver version');
  assert.ok(checkSignature({ ...goodSig, adult: undefined }).error, 'age not answered');
});

test('agreements are current only for the latest versions of both', () => {
  assert.equal(isCurrent({ waiverVersion: WAIVER.version, rulesVersion: RULES.version }), true);
  assert.equal(isCurrent({ waiverVersion: WAIVER.version, rulesVersion: 'old' }), false);
  assert.equal(isCurrent(null), false);
});

// ── Cash credit amounts: $5 steps, $5 – $200 ──
import { cashCreditCents } from '../src/lib/cash.js';

test('cash credit: $5 steps are accepted, missing means $5', () => {
  assert.equal(cashCreditCents(undefined), 500);
  assert.equal(cashCreditCents(500), 500);
  assert.equal(cashCreditCents(1000), 1000);
  assert.equal(cashCreditCents(2000), 2000);
  assert.equal(cashCreditCents(20000), 20000);
});

test('cash credit: anything else is rejected', () => {
  for (const bad of [0, 250, 750, -500, 20500, 12.5, 'ten', '1000x']) {
    assert.equal(typeof cashCreditCents(bad), 'string', String(bad));
  }
});
