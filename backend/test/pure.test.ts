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

test('offers: a year pass covers the quarter, but it is not shown as owning a quarter pass', () => {
  for (const d of ['2026-05-01', '2026-11-08', '2027-02-01']) {
    const yPass: any = { plan: 'year', periodId: periodFor('year', d).periodId };
    const offers = purchasable(yPass, d);
    assert.equal(offers.find((o) => o.plan === 'year')!.status, 'owned', d);
    assert.equal(offers.find((o) => o.plan === 'quarter')!.status, 'covered', d);
    assert.equal(offers.find((o) => o.plan === 'quarter')!.available, false, d);
  }
});

// ── Expenses: input validation + season range ──
import { checkExpense, seasonRange, seasonLabel, quarterRange } from '../src/lib/expenses.js';

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

// ── Security hardening ──
import { paymentView, isSamePerson } from '../src/lib/views.js';
import { cleanName, cleanEmail, isId, isPin, oneLine } from '../src/lib/text.js';
import { hashToken, verifyToken, makeToken } from '../src/lib/crypto.js';

test('payments shown to players never include the confirm token or table keys', () => {
  const stored = {
    PK: 'PLAYER#a', SK: 'PAYMENT#x', GSI1PK: 'PAYMENT_STATUS#pending', GSI1SK: 'x',
    paymentId: 'p1', playerId: 'a', amountCents: 500, method: 'cash', status: 'pending',
    adminId: 'ad', confirmToken: 'SECRET', checkoutUrl: 'https://checkout', stripeSessionId: 'cs_1',
    createdAt: '2026-01-01T00:00:00Z',
  };
  const v = paymentView(stored);
  const json = JSON.stringify(v);
  for (const k of ['SECRET', 'PK', 'SK', 'GSI1', 'confirmToken', 'checkoutUrl', 'cs_1', 'adminId']) {
    assert.equal(json.includes(k), false, k);
  }
  assert.equal(v.amountCents, 500);
  assert.equal(v.status, 'pending');
});

test('same person: by account or by email, case-insensitive', () => {
  assert.equal(isSamePerson({ cognitoSub: 's1' }, { cognitoSub: 's1' }), true);
  assert.equal(isSamePerson({ email: 'A@x.org' }, { email: 'a@x.org ' }), true);
  assert.equal(isSamePerson({ cognitoSub: 's1', email: 'a@x.org' }, { cognitoSub: 's2', email: 'b@x.org' }), false);
  assert.equal(isSamePerson({}, {}), false);
});

test('names: invisible and bidi characters stripped, capped at 60', () => {
  assert.equal(cleanName('  Steph\u202e  Curry\u200b\n'), 'Steph Curry');
  assert.equal(cleanName('x'.repeat(500)).length, 60);
  assert.equal(cleanName(42), '');
  assert.equal(cleanName('\u200b\u202e'), '');
  assert.equal(cleanName('Ｍｉｃｈａｅｌ'), 'Michael'); // NFKC
});

test('one-line titles: no CR/LF', () => {
  assert.equal(oneLine('a\r\nBcc: x@y.z'), 'a Bcc: x@y.z');
});

test('emails: valid ones lower-cased, long or odd ones rejected fast', () => {
  assert.equal(cleanEmail(' Dexter@Example.ORG '), 'dexter@example.org');
  assert.equal(cleanEmail('a@b'), null);
  assert.equal(cleanEmail(['a@b.co']), null);
  const t = Date.now();
  assert.equal(cleanEmail('a@' + '.'.repeat(50000) + ' '), null);
  assert.ok(Date.now() - t < 200);
});

test('ids and PINs', () => {
  assert.equal(isId('433e3475d9fb75ab207ced0a'), true);
  assert.equal(isId(['433e3475d9fb75ab207ced0a']), false);
  assert.equal(isPin('1234'), true);
  assert.equal(isPin('123456'), true);
  assert.equal(isPin('123'), false);
  assert.equal(isPin('1'.repeat(100000)), false);
  assert.equal(isPin({}), false);
});

test('kiosk tokens: fast hash verifies only the right token', () => {
  const t = makeToken();
  const h = hashToken(t);
  assert.equal(verifyToken(t, h), true);
  assert.equal(verifyToken(makeToken(), h), false);
  assert.equal(verifyToken(t, 'salt:hash'), false);
});

// ── Club notices ──
import { checkNotice } from '../src/lib/notices.js';

test('notices: text and last day are checked', () => {
  const today = '2026-11-08';
  assert.deepEqual(checkNotice({ text: '  Gym closed for the next 3 weeks ', until: '2026-11-29' }, today), {
    text: 'Gym closed for the next 3 weeks',
    until: '2026-11-29',
  });
  assert.equal(checkNotice({ text: 'Line one\r\n\r\n\r\nLine\u202e two', until: today }, today).text, 'Line one\n\nLine two');
  assert.ok(checkNotice({ text: '', until: today }, today).error);
  assert.ok(checkNotice({ text: 'x'.repeat(501), until: today }, today).error);
  assert.ok(checkNotice({ text: 'Hi', until: '2026-11-07' }, today).error, 'past');
  assert.ok(checkNotice({ text: 'Hi', until: '2027-06-01' }, today).error, 'over 180 days');
  assert.ok(checkNotice({ text: 'Hi', until: 'next week' }, today).error);
  assert.ok(checkNotice({ text: { x: 1 }, until: today }, today).error);
});

// ── Pagination cursors ──
import { sealCursor, openCursor, pageLimit, BadCursor, CURSOR_TTL_SECONDS } from '../src/lib/page.js';
import { randomBytes as rb } from 'node:crypto';

test('cursors are sealed: opaque, tamper-proof, bound to their list, expiring', () => {
  const secret = rb(32);
  const part = { PK: 'PLAYER#abc' };
  const key = { PK: 'PLAYER#abc', SK: 'PAYMENT#2026-01-01T00:00:00Z#x' };
  const c = sealCursor(key, part, secret)!;
  assert.deepEqual(openCursor(c, part, secret), key);
  // Opaque: nothing of the key is readable.
  const raw = Buffer.from(c, 'base64url').toString('latin1');
  assert.ok(!raw.includes('PLAYER') && !raw.includes('2026'));
  // Two cursors for the same key differ (random IV).
  assert.notEqual(sealCursor(key, part, secret), c);
  assert.equal(openCursor(undefined, part, secret), undefined);
  assert.equal(openCursor('', part, secret), undefined);
  assert.equal(sealCursor(undefined, part, secret), null);
  // Another list, a different key, any edited byte, junk: refused.
  assert.throws(() => openCursor(c, { PK: 'PLAYER#other' }, secret), BadCursor);
  assert.throws(() => openCursor(c, part, rb(32)), BadCursor);
  // Same partition, different list (payments vs check-ins): refused.
  const sc = sealCursor(key, part, secret, undefined, 'payments')!;
  assert.deepEqual(openCursor(sc, part, secret, undefined, 'payments'), key);
  assert.throws(() => openCursor(sc, part, secret, undefined, 'checkins'), BadCursor);
  const bytes = Buffer.from(c, 'base64url');
  for (const i of [0, 5, 20, bytes.length - 1]) {
    const b2 = Buffer.from(bytes);
    b2[i] ^= 1;
    assert.throws(() => openCursor(b2.toString('base64url'), part, secret), BadCursor, `byte ${i}`);
  }
  assert.throws(() => openCursor(Buffer.from(JSON.stringify(key)).toString('base64url'), part, secret), BadCursor, 'plain JSON');
  assert.throws(() => openCursor('not base64!', part, secret), BadCursor);
  assert.throws(() => openCursor('x'.repeat(2000), part, secret), BadCursor);
  assert.throws(() => openCursor(['a'], part, secret), BadCursor);
  // Expired.
  const now = Math.floor(Date.now() / 1000);
  const old = sealCursor(key, part, secret, now - CURSOR_TTL_SECONDS - 1)!;
  assert.throws(() => openCursor(old, part, secret, now), BadCursor);
  // Sealed but with a key outside the partition / extra attributes: still refused.
  assert.throws(() => openCursor(sealCursor({ PK: 'PLAYER#zzz', SK: 'x' }, part, secret)!, part, secret), BadCursor);
  assert.throws(() => openCursor(sealCursor({ ...key, balanceCents: 'x' }, part, secret)!, part, secret), BadCursor);
});

test('page limits are clamped', () => {
  assert.equal(pageLimit(undefined, 25, 100), 25);
  assert.equal(pageLimit('10', 25, 100), 10);
  assert.equal(pageLimit('5000', 25, 100), 100);
  assert.equal(pageLimit('0', 25, 100), 25);
  assert.equal(pageLimit('abc', 25, 100), 25);
});

// ── Phone + emergency contact ──
import { normalizePhone, checkContact, hasContact } from '../src/lib/contact.js';

test('phones: common US formats become E.164, junk is refused', () => {
  for (const v of ['(415) 555-0123', '415.555.0123', '415 555 0123', '4155550123', '1 415 555 0123', '+1 415-555-0123']) {
    assert.equal(normalizePhone(v), '+14155550123', v);
  }
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  for (const v of ['555-0123', '015 555 0123', 'call me', '', '+0123456789', '1'.repeat(41), 4155550123, null]) {
    assert.equal(normalizePhone(v as any), null, String(v));
  }
});

test('contact: all three required, cleaned, emergency number must differ', () => {
  const ok = checkContact({ phone: '415-555-0123', emergencyName: '  Riley\u202e Rivera ', emergencyPhone: '(510) 555-0199' });
  assert.deepEqual(ok.contact, { phone: '+14155550123', emergencyName: 'Riley Rivera', emergencyPhone: '+15105550199' });
  assert.ok(checkContact({ emergencyName: 'Riley', emergencyPhone: '5105550199' }).error);
  assert.ok(checkContact({ phone: '4155550123', emergencyPhone: '5105550199' }).error);
  assert.ok(checkContact({ phone: '4155550123', emergencyName: 'Riley' }).error);
  assert.ok(checkContact({ phone: '4155550123', emergencyName: 'Riley', emergencyPhone: '(415) 555-0123' }).error);
  assert.equal(hasContact({ phone: '+1', emergencyName: 'a', emergencyPhone: '+1' }), true);
  assert.equal(hasContact({ phone: '+1' }), false);
});

// ── Chat reactions ──
import { cleanEmoji, reactionAttr } from '../src/lib/emoji.js';

test('reactions: one emoji only, including flags, skin tones and families', () => {
  for (const e of ['👍', '❤️', '🏀', '🔥', '👍🏽', '🇺🇸', '👨‍👩‍👧', '1️⃣', '🏳️‍🌈']) assert.equal(cleanEmoji(e), e, e);
  for (const bad of ['', 'a', 'lol', '👍👍', '👍 ', '1', '\u200d', '<b>', '🏀a', 42, null, '😀'.repeat(20)]) {
    assert.equal(cleanEmoji(bad as any), null, String(bad));
  }
});

test('reactions: attribute names are safe and reversible', () => {
  const a = reactionAttr('👨‍👩‍👧');
  assert.match(a, /^rx_[0-9a-f]+$/);
  assert.equal(Buffer.from(a.slice(3), 'hex').toString('utf8'), '👨‍👩‍👧');
});

test('expenses: quarters of a season, Q4 in the next calendar year', () => {
  assert.deepEqual([1, 2, 3, 4].map((q) => quarterRange(2026, q as 1).start), ['2026-04-01', '2026-07-01', '2026-10-01', '2027-01-01']);
  assert.deepEqual([1, 2, 3, 4].map((q) => quarterRange(2026, q as 1).end), ['2026-06-30', '2026-09-30', '2026-12-31', '2027-03-31']);
  assert.match(quarterRange(2026, 3).label, /^Q3 2026–27/);
});
