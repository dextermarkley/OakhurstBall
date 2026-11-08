// Payment engine. Every payment starts PENDING and is settled exactly once:
//   cash → the chosen admin taps the notification's confirm link (confirm/deny), or uses
//          the Confirm/Deny buttons on the Admin page
//   card → Stripe reports the Checkout session paid (kiosk poll, return page,
//          or webhook — whichever arrives first; the rest are no-ops)
// Settling is one DynamoDB transaction conditioned on status = pending, so a
// payment can never be credited twice.
import { TransactWriteCommand, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1, keys, gsi, sha256 } from './ddb.js';
import { queryAll, queryPage } from './page.js';
import { makeToken, newId } from './crypto.js';
import { createCheckoutSession, retrieveCheckoutSession } from './stripe.js';
import { PLAN_PRICES, periodFor, type Plan } from './plans.js';
import { passItem, passKey } from './passes.js';
import { isSamePerson } from './views.js';
import { clubDate, getAdmin, getPlayer, pendingPaymentsOf } from './repo.js';
import { sendPush, toAdmin, toPlayer } from './push.js';
import { refundCurrentSessionFee } from './sessions.js';
import type { Payment, PaymentMethod } from './types.js';

/** What a payment buys: balance credit (no plan) or a period pass. */
interface Purchase {
  amountCents: number;
  plan?: Plan;
  periodId?: string;
  periodLabel?: string;
  periodStart?: string;
  periodEnd?: string;
  what: string; // human description, e.g. "Q1 2026–27 quarter pass"
}

/** "Q1 2026–27 (Apr 1 – Jun 30)" → "Q1 2026–27"; "2026–27 season" → "2026–27". */
const shortPeriod = (label: string) => label.replace(/ \(.*\)$/, '').replace(/ season$/, '');

function purchaseFor(plan: Plan | undefined, creditCents: number): Purchase {
  if (!plan) return { amountCents: creditCents, what: 'account credit' };
  const p = periodFor(plan, clubDate());
  return {
    amountCents: PLAN_PRICES[plan],
    plan,
    periodId: p.periodId,
    periodLabel: p.label,
    periodStart: p.start,
    periodEnd: p.end,
    // Short name for pushes/emails; the long label stays in periodLabel.
    what: plan === 'year' ? `${shortPeriod(p.label)} year pass` : `${shortPeriod(p.label)} quarter pass`,
  };
}
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** Cash payments a player can have waiting for confirmation at once. */
export const MAX_PENDING_CASH = 3;
/** New Stripe Checkout pages a player can open per 25 minutes. */
const MAX_RECENT_CHECKOUTS = 4;

/** A payment the rules don't allow (shown to the person as-is, HTTP 409). */
export class PaymentRefused extends Error {}



const cents = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
};

/** Fixed amounts, enforced server-side (the kiosk never chooses an amount). */
export const AMOUNTS = {
  dailyFee: cents('DAILY_FEE_CENTS', 500),
  card: cents('CARD_AMOUNT_CENTS', 2000),
  cash: cents('CASH_AMOUNT_CENTS', 500),
};

const nowIso = () => new Date().toISOString();
const baseUrl = () => process.env.APP_BASE_URL ?? '';
export const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

const paymentRefKey = (paymentId: string) => ({ PK: `PAYREF#${paymentId}`, SK: 'REF' });

/** Write a pending payment, its PAYREF lookup row, and (cash) its confirm-link token row. */
async function writePending(p: {
  paymentId: string;
  playerId: string;
  purchase: Purchase;
  method: PaymentMethod;
  adminId?: string;
  stripeSessionId?: string;
  checkoutUrl?: string;
  note?: string;
  withToken: boolean;
}): Promise<{ payment: Payment; token?: string }> {
  const createdAt = nowIso();
  const sortKey = keys.payment(p.playerId, createdAt, p.paymentId).SK;
  const token = p.withToken ? makeToken() : undefined;

  const payment: Payment = {
    paymentId: p.paymentId,
    playerId: p.playerId,
    amountCents: p.purchase.amountCents,
    plan: p.purchase.plan,
    periodId: p.purchase.periodId,
    periodLabel: p.purchase.periodLabel,
    periodStart: p.purchase.periodStart,
    periodEnd: p.purchase.periodEnd,
    method: p.method,
    status: 'pending',
    adminId: p.adminId,
    stripeSessionId: p.stripeSessionId,
    // Only a hash of the confirm token is stored: whoever holds the token can
    // confirm the cash, and the payment is shown to the player who made it.
    confirmTokenHash: token ? sha256(token) : undefined,
    createdAt,
    note: p.note,
  };

  const items: any[] = [
    {
      Put: {
        TableName: TABLE,
        Item: {
          PK: `PLAYER#${p.playerId}`,
          SK: sortKey,
          ...payment,
          checkoutUrl: p.checkoutUrl, // server-side only (reused for a repeat tap)
          ...gsi.paymentStatus('pending'),
          GSI1SK: createdAt,
        },
      },
    },
    { Put: { TableName: TABLE, Item: { ...paymentRefKey(p.paymentId), playerId: p.playerId, sortKey } } },
  ];
  if (token) {
    items.push({
      Put: {
        TableName: TABLE,
        Item: {
          ...keys.tokenHash(sha256(token)),
          playerId: p.playerId,
          paymentId: p.paymentId,
          paymentSortKey: sortKey,
          expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS, // DynamoDB TTL
        },
      },
    });
  }
  await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  return { payment, token };
}

/** Tell the player's devices how their payment turned out. */
async function notifySettled(playerId: string, payment: Payment, outcome: 'confirmed' | 'denied', madePass: boolean) {
  const amount = dollars(payment.amountCents);
  const how = payment.method === 'cash' ? 'cash' : 'card';
  let title: string;
  let body: string;
  if (outcome === 'denied') {
    title = 'Cash payment not confirmed';
    body = `Your ${amount} cash payment wasn't confirmed. Please check with an admin.`;
  } else if (madePass) {
    title = `Your ${payment.plan === 'year' ? 'year' : 'quarter'} pass is active`;
    body = `${payment.periodLabel ? `Covered for ${shortPeriod(payment.periodLabel)}. ` : ''}Paid ${amount} by ${how}.`;
  } else {
    const p = await getPlayer(playerId).catch(() => null);
    const bal = p?.balanceCents;
    title = 'Payment received';
    body =
      `${amount} ${how} payment confirmed.` +
      (bal == null ? '' : ` Your balance is ${bal < 0 ? '−' : ''}${dollars(Math.abs(bal))}.`);
  }
  await sendPush(toPlayer(playerId), { title, body, url: '/player', tag: `pay-${payment.paymentId}` });
}

/**
 * Settle a pending payment exactly once, in one transaction conditioned on
 * status = pending. On 'confirmed':
 *   - a plain payment credits the balance;
 *   - a pass payment creates the pass (condition: not already held). If the player
 *     already holds that pass (two purchases raced), the money is credited to the
 *     balance instead, so nothing is lost.
 * Returns 'already' if the payment was settled before.
 */
async function settle(
  playerId: string,
  sortKey: string,
  payment: Payment,
  outcome: 'confirmed' | 'denied' | 'expired',
  deleteTokenKey: { PK: string; SK: string } | undefined,
  settledBy: string,
  asCredit = false,
): Promise<'done' | 'already'> {
  const now = nowIso();
  // A pass for a period that has already ended (cash confirmed late) is worth
  // nothing, so the money goes to the balance instead.
  if (outcome === 'confirmed' && payment.plan && payment.periodEnd && payment.periodEnd < clubDate()) asCredit = true;
  const makePass = outcome === 'confirmed' && !!payment.plan && !!payment.periodId && !asCredit;
  const items: any[] = [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `PLAYER#${playerId}`, SK: sortKey },
        UpdateExpression:
          'SET #s = :out, settledAt = :now, settledBy = :by, GSI1PK = :gpk' +
          (asCredit ? ', creditedInstead = :t' : '') +
          ' REMOVE confirmToken, checkoutUrl',
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':out': outcome,
          ':pending': 'pending',
          ':now': now,
          ':by': settledBy,
          ':gpk': `PAYMENT_STATUS#${outcome}`,
          ...(asCredit ? { ':t': true } : {}),
        },
      },
    },
  ];
  if (makePass) {
    items.push({
      Put: {
        TableName: TABLE,
        Item: passItem({
          playerId,
          plan: payment.plan!,
          periodId: payment.periodId!,
          label: payment.periodLabel ?? payment.periodId!,
          start: payment.periodStart ?? '',
          end: payment.periodEnd ?? '',
          amountCents: payment.amountCents,
          source: payment.method === 'card' ? 'card' : 'cash',
          paymentId: payment.paymentId,
          createdAt: now,
        }),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
  } else if (outcome === 'confirmed') {
    items.push({
      Update: {
        TableName: TABLE,
        Key: keys.playerProfile(playerId),
        UpdateExpression: 'ADD balanceCents :amt SET updatedAt = :now',
        ExpressionAttributeValues: { ':amt': payment.amountCents, ':now': now },
      },
    });
  }
  if (deleteTokenKey) items.push({ Delete: { TableName: TABLE, Key: deleteTokenKey } });

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    if (makePass) {
      // The new pass also covers the session they may already have paid for.
      await refundCurrentSessionFee(playerId, {
        plan: payment.plan!,
        start: payment.periodStart ?? '',
        end: payment.periodEnd ?? '',
      }).catch((e) => console.error('session fee refund failed', { paymentId: payment.paymentId, e }));
    }
    if (outcome !== 'expired') await notifySettled(playerId, payment, outcome, makePass);
    return 'done';
  } catch (err: any) {
    if (err?.name !== 'TransactionCanceledException') throw err;
    const code = (i: number) => err.CancellationReasons?.[i]?.Code;
    // Payment still pending but the pass already exists → credit the money instead.
    if (makePass && code(0) !== 'ConditionalCheckFailed' && code(1) === 'ConditionalCheckFailed') {
      console.warn('pass already held; crediting balance instead', { paymentId: payment.paymentId });
      return settle(playerId, sortKey, payment, outcome, deleteTokenKey, settledBy, true);
    }
    return 'already';
  }
}

/** Look up a payment by id (via its PAYREF row). */
export async function getPayment(paymentId: string) {
  const ref = await ddb.send(new GetCommand({ TableName: TABLE, Key: paymentRefKey(paymentId) }));
  if (!ref.Item) return null;
  const { playerId, sortKey } = ref.Item as { playerId: string; sortKey: string };
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${playerId}`, SK: sortKey } }));
  return r.Item ? { playerId, sortKey, payment: r.Item as Payment } : null;
}

// ─────────────────────────────── Cash ──────────────────────────────────────
/**
 * Record a pending cash payment and send the chosen admin a notification that
 * opens a one-tap confirm page. The payment is written first, so it always shows
 * on the Admin page too; `notified` says whether any of the admin's devices got
 * the notification (if not, they confirm it on the Admin page).
 */
export async function createCashPayment(input: {
  playerId: string;
  playerName: string;
  adminId: string;
  adminEmail?: string;
  plan?: Plan;
  /** Credit amount (ignored for passes, which have a fixed price). */
  creditCents?: number;
}): Promise<{ payment: Payment; notified: boolean }> {
  const [player, adm, pending] = await Promise.all([
    getPlayer(input.playerId),
    getAdmin(input.adminId),
    pendingPaymentsOf(input.playerId),
  ]);
  // Nobody confirms their own cash: the admin who receives it must be someone else.
  if (player && adm && isSamePerson(player, adm)) {
    throw new PaymentRefused('You can’t confirm your own cash. Hand it to a different admin and pick them.');
  }
  if (pending.filter((p) => p.method === 'cash').length >= MAX_PENDING_CASH) {
    throw new PaymentRefused(
      'You already have cash payments waiting for an admin to confirm. Ask them to confirm those first.',
    );
  }
  const purchase = purchaseFor(input.plan, input.creditCents ?? AMOUNTS.cash);
  const amountCents = purchase.amountCents;
  const { payment, token } = await writePending({
    paymentId: newId(),
    playerId: input.playerId,
    purchase,
    method: 'cash',
    adminId: input.adminId,
    note: `Cash — ${input.playerName} — ${purchase.what}`,
    withToken: true,
  });

  const amount = dollars(amountCents);
  // Notify the admin's devices; tapping opens the one-tap confirm page.
  const push = await sendPush(
    toAdmin({ cognitoSub: adm?.cognitoSub, email: input.adminEmail ?? adm?.email }),
    {
      title: `Cash from ${input.playerName}: ${amount}`,
      body: `Confirm you got ${amount}${input.plan ? ` for a ${purchase.what}` : ''}. Tap to confirm or deny.`,
      url: `/confirm/${token}`,
      tag: `cash-${payment.paymentId}`,
    },
    { urgency: 'high', ttlSeconds: 24 * 3600 },
  );
  return { payment, notified: push.sent > 0 };
}

/**
 * Settle a pending payment from the Admin page. Cash only: card payments are
 * settled by Stripe, so an admin can't mark one paid by hand.
 */
export async function adminSettle(
  paymentId: string,
  outcome: 'confirmed' | 'denied',
  by: { sub: string },
): Promise<'done' | 'already' | 'notfound' | 'notcash' | 'self'> {
  const found = await getPayment(paymentId);
  if (!found) return 'notfound';
  const { playerId, sortKey, payment } = found;
  if (payment.method !== 'cash') return 'notcash';
  if (payment.status !== 'pending') return 'already';
  // An admin can't confirm their own cash (denying it is fine).
  if (outcome === 'confirmed') {
    const player = await getPlayer(playerId);
    if (player?.cognitoSub && player.cognitoSub === by.sub) return 'self';
  }
  return settle(
    playerId,
    sortKey,
    payment,
    outcome,
    payment.confirmTokenHash
      ? keys.tokenHash(payment.confirmTokenHash)
      : payment.confirmToken
        ? keys.token(payment.confirmToken)
        : undefined,
    `admin:${by.sub}`,
  );
}

/** Resolve a confirm-link token → its pending payment. */
export async function resolveToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  let tokenKey = keys.tokenHash(sha256(token));
  let res = await ddb.send(new GetCommand({ TableName: TABLE, Key: tokenKey }));
  if (!res.Item) {
    tokenKey = keys.token(token); // link sent before tokens were hashed
    res = await ddb.send(new GetCommand({ TableName: TABLE, Key: tokenKey }));
  }
  if (!res.Item) return null;
  // DynamoDB TTL deletes lazily (up to days later), so enforce the expiry here.
  if (Number(res.Item.expiresAt ?? 0) <= Math.floor(Date.now() / 1000)) return null;
  const { playerId, paymentSortKey } = res.Item as { playerId: string; paymentSortKey: string };
  const pay = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${playerId}`, SK: paymentSortKey } }),
  );
  if (!pay.Item) return null;
  return { playerId, paymentSortKey, tokenKey, payment: pay.Item as Payment };
}

async function settleByToken(token: string, outcome: 'confirmed' | 'denied') {
  const r = await resolveToken(token);
  if (!r) return 'gone' as const;
  if (r.payment.status !== 'pending') return 'already' as const;
  const res = await settle(r.playerId, r.paymentSortKey, r.payment, outcome, r.tokenKey, 'link');
  return res === 'done' ? outcome : ('already' as const);
}
export const confirmPayment = (token: string) => settleByToken(token, 'confirmed');
export const denyPayment = (token: string) => settleByToken(token, 'denied');

// ─────────────────────────────── Card ──────────────────────────────────────
export async function createCardPayment(input: { playerId: string; playerName: string; plan?: Plan; email?: string }) {
  const purchase = purchaseFor(input.plan, AMOUNTS.card);
  // A repeat tap reuses the Checkout page opened in the last 25 minutes (Stripe
  // expires them at 35), so tapping Pay over and over can't flood Stripe.
  const pendingCard = (await pendingPaymentsOf(input.playerId)).filter((p) => p.method === 'card');
  const fresh = Date.now() - 25 * 60 * 1000;
  const reuse = pendingCard.find(
    (p: any) =>
      p.checkoutUrl &&
      Date.parse(p.createdAt) > fresh &&
      (p.plan ?? null) === (purchase.plan ?? null) &&
      p.amountCents === purchase.amountCents &&
      (p.periodId ?? null) === (purchase.periodId ?? null),
  ) as (Payment & { checkoutUrl: string }) | undefined;
  if (reuse) return { payment: reuse, checkoutUrl: reuse.checkoutUrl };
  if (pendingCard.filter((p) => Date.parse(p.createdAt) > fresh).length >= MAX_RECENT_CHECKOUTS) {
    throw new PaymentRefused('Too many card payments started. Wait a few minutes and try again.');
  }
  const paymentId = newId();
  const session = await createCheckoutSession({
    paymentId,
    playerId: input.playerId,
    playerName: input.playerName,
    amountCents: purchase.amountCents,
    productName: input.plan
      ? `Oakhurst Basketball ${input.plan === 'year' ? 'year' : 'quarter'} pass (${shortPeriod(purchase.periodLabel ?? '')})`
      : `Oakhurst Basketball account credit (${dollars(purchase.amountCents)})`,
    productDescription: input.plan
      ? `Covers every pickup session, ${purchase.periodLabel}. For ${input.playerName}.`
      : `Pays for ${dollars(AMOUNTS.dailyFee)} pickup sessions. For ${input.playerName}.`,
    baseUrl: baseUrl(),
    email: input.email,
  });
  const { payment } = await writePending({
    paymentId,
    playerId: input.playerId,
    purchase,
    method: 'card',
    stripeSessionId: session.id,
    checkoutUrl: session.url,
    note: `Card — ${input.playerName} — ${purchase.what}`,
    withToken: false,
  });
  return { payment, checkoutUrl: session.url };
}

/**
 * Ask Stripe for the truth about a card payment and settle it if Stripe says paid
 * (or expired). Safe to call any number of times from any path.
 */
export async function syncCardPayment(paymentId: string): Promise<Payment['status'] | 'unknown'> {
  const found = await getPayment(paymentId);
  if (!found) return 'unknown';
  const { playerId, sortKey, payment } = found;
  if (payment.method !== 'card' || !payment.stripeSessionId) return payment.status;
  if (payment.status !== 'pending') return payment.status;

  const s = await retrieveCheckoutSession(payment.stripeSessionId);
  // Cross-check what Stripe charged against what we recorded before crediting.
  const matches =
    s.metadata?.paymentId === paymentId && s.amount_total === payment.amountCents && s.currency === 'usd';
  if (s.payment_status === 'paid' && matches) {
    await settle(playerId, sortKey, payment, 'confirmed', undefined, 'stripe');
    return 'confirmed';
  }
  if (s.payment_status === 'paid' && !matches) {
    console.error('stripe session mismatch', { paymentId, session: s.id, amount: s.amount_total });
    return 'pending';
  }
  if (s.status === 'expired') {
    await settle(playerId, sortKey, payment, 'expired', undefined, 'stripe');
    return 'expired';
  }
  return 'pending';
}

// ─────────────────────── Card refunds and disputes ─────────────────────────
/**
 * Stripe says money for a confirmed card payment went back (refund) or is being
 * clawed back (dispute / chargeback). Take back what it bought, once:
 *   - a pass bought by this payment is removed;
 *   - otherwise the amount comes off the balance (it may go negative).
 * Then notify every admin's devices. Returns false if nothing to do.
 */
export async function reverseCardPayment(paymentId: string, kind: 'refunded' | 'disputed'): Promise<boolean> {
  const found = await getPayment(paymentId);
  if (!found) return false;
  const { playerId, sortKey, payment } = found;
  if (payment.method !== 'card' || payment.status !== 'confirmed' || payment.reversed) return false;
  const now = nowIso();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `PLAYER#${playerId}`, SK: sortKey },
        UpdateExpression: 'SET reversed = :k, reversedAt = :now',
        ConditionExpression: '#s = :c AND attribute_not_exists(reversed)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':k': kind, ':now': now, ':c': 'confirmed' },
      }),
    );
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
  let what = `${dollars(payment.amountCents)} taken off their balance`;
  let passRemoved = false;
  if (payment.plan && payment.periodId && !payment.creditedInstead) {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE,
          Key: passKey(playerId, payment.periodId),
          ConditionExpression: 'paymentId = :p',
          ExpressionAttributeValues: { ':p': paymentId },
        }),
      );
      passRemoved = true;
      what = `their ${payment.periodLabel ?? payment.plan} pass removed`;
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    }
  }
  if (!passRemoved) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `PLAYER#${playerId}`, SK: 'PROFILE' },
        UpdateExpression: 'ADD balanceCents :d SET updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':d': -payment.amountCents, ':now': now },
      }),
    );
  }
  const player = await getPlayer(playerId).catch(() => null);
  const name = player?.name ?? 'A player';
  const title = `Card payment ${kind === 'refunded' ? 'refunded' : 'disputed'}: ${name}`;
  const body = `${dollars(payment.amountCents)} card payment ${kind === 'refunded' ? 'was refunded' : 'is disputed (chargeback)'} in Stripe, so the app has ${what}.`;
  console.warn('card payment reversed', { paymentId, kind, passRemoved });
  await sendPush((s) => !!s.isAdmin, { title, body, url: '/admin?tab=players', tag: `reverse-${paymentId}` }, {
    urgency: 'high',
    ttlSeconds: 7 * 86400,
  });
  return true;
}

/** One page of the admin queue, newest first. */
export async function listPendingPage(cursor: unknown, limit: number) {
  return queryPage<Payment>(
    {
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'PAYMENT_STATUS#pending' },
      ScanIndexForward: false,
    },
    { cursor, limit, partition: { GSI1PK: 'PAYMENT_STATUS#pending' } },
  );
}

/** The whole admin queue (server-side use). */
export async function listPending(): Promise<Payment[]> {
  return queryAll<Payment>({
    TableName: TABLE,
    IndexName: GSI1,
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'PAYMENT_STATUS#pending' },
  });
}
