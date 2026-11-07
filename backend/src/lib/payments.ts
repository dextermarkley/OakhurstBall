// Payment engine. Every payment starts PENDING and is settled exactly once:
//   cash → the chosen admin taps the emailed magic link (confirm/deny), or uses
//          the Confirm/Deny buttons on the Admin page
//   card → Stripe reports the Checkout session paid (kiosk poll, return page,
//          or webhook — whichever arrives first; the rest are no-ops)
// Settling is one DynamoDB transaction conditioned on status = pending, so a
// payment can never be credited twice.
import { TransactWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, GSI1, keys, gsi } from './ddb.js';
import { makeToken, newId } from './crypto.js';
import { createCheckoutSession, retrieveCheckoutSession } from './stripe.js';
import { sendEmail, escapeHtml } from './email.js';
import { PLAN_PRICES, periodFor, type Plan } from './plans.js';
import { passItem } from './passes.js';
import { clubDate } from './repo.js';
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
    what: plan === 'year' ? `${p.label} year pass` : `${p.label} quarter pass`,
  };
}
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

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
    confirmToken: token,
    createdAt,
    note: p.note,
  };

  const items: any[] = [
    {
      Put: {
        TableName: TABLE,
        Item: { PK: `PLAYER#${p.playerId}`, SK: sortKey, ...payment, ...gsi.paymentStatus('pending'), GSI1SK: createdAt },
      },
    },
    { Put: { TableName: TABLE, Item: { ...paymentRefKey(p.paymentId), playerId: p.playerId, sortKey } } },
  ];
  if (token) {
    items.push({
      Put: {
        TableName: TABLE,
        Item: {
          ...keys.token(token),
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
  deleteTokenKey?: { PK: string; SK: string },
  asCredit = false,
): Promise<'done' | 'already'> {
  const now = nowIso();
  const makePass = outcome === 'confirmed' && !!payment.plan && !!payment.periodId && !asCredit;
  const items: any[] = [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: `PLAYER#${playerId}`, SK: sortKey },
        UpdateExpression:
          'SET #s = :out, settledAt = :now, GSI1PK = :gpk' +
          (asCredit ? ', creditedInstead = :t' : '') +
          ' REMOVE confirmToken',
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':out': outcome,
          ':pending': 'pending',
          ':now': now,
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
    return 'done';
  } catch (err: any) {
    if (err?.name !== 'TransactionCanceledException') throw err;
    const code = (i: number) => err.CancellationReasons?.[i]?.Code;
    // Payment still pending but the pass already exists → credit the money instead.
    if (makePass && code(0) !== 'ConditionalCheckFailed' && code(1) === 'ConditionalCheckFailed') {
      console.warn('pass already held; crediting balance instead', { paymentId: payment.paymentId });
      return settle(playerId, sortKey, payment, outcome, deleteTokenKey, true);
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
 * Record a pending cash payment and email the chosen admin a one-tap confirm link.
 * The payment is written first, so if the email fails it still shows on the Admin
 * page and can be confirmed there; `emailed` tells the kiosk which happened.
 */
export async function createCashPayment(input: {
  playerId: string;
  playerName: string;
  adminId: string;
  adminEmail?: string;
  plan?: Plan;
}): Promise<{ payment: Payment; emailed: boolean }> {
  const purchase = purchaseFor(input.plan, AMOUNTS.cash);
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
  if (!input.adminEmail) return { payment, emailed: false };

  const link = `${baseUrl()}/confirm/${token}`;
  const amount = dollars(amountCents);
  const name = escapeHtml(input.playerName);
  const forWhat = input.plan ? ` for a ${purchase.what}` : '';
  try {
    await sendEmail({
      to: input.adminEmail,
      subject: `Confirm ${amount} cash from ${input.playerName}${forWhat}`,
      text:
        `${input.playerName} says they gave you ${amount} cash${forWhat} at Oakhurst Basketball.\n\n` +
        `Confirm or deny it here: ${link}\n\n` +
        `The link expires in 24 hours. You can also confirm it on the Admin page.`,
      html:
        `<p><strong>${name}</strong> says they gave you <strong>${amount} cash</strong>` +
        `${escapeHtml(forWhat)} at Oakhurst Basketball.</p>` +
        `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#e8730c;` +
        `color:#fff;border-radius:8px;text-decoration:none;font-weight:600">` +
        `Confirm or deny</a></p>` +
        `<p style="color:#6b7684;font-size:13px">The link expires in 24 hours. ` +
        `You can also confirm it on the Admin page.</p>`,
    });
    return { payment, emailed: true };
  } catch (err) {
    console.error('cash confirm email failed', { paymentId: payment.paymentId, err });
    return { payment, emailed: false };
  }
}

/**
 * Settle a pending payment from the Admin page. Cash only: card payments are
 * settled by Stripe, so an admin can't mark one paid by hand.
 */
export async function adminSettle(
  paymentId: string,
  outcome: 'confirmed' | 'denied',
): Promise<'done' | 'already' | 'notfound' | 'notcash'> {
  const found = await getPayment(paymentId);
  if (!found) return 'notfound';
  const { playerId, sortKey, payment } = found;
  if (payment.method !== 'cash') return 'notcash';
  if (payment.status !== 'pending') return 'already';
  return settle(
    playerId,
    sortKey,
    payment,
    outcome,
    payment.confirmToken ? keys.token(payment.confirmToken) : undefined,
  );
}

/** Resolve an emailed confirm token → its pending payment. */
export async function resolveToken(token: string) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: keys.token(token) }));
  if (!res.Item) return null;
  const { playerId, paymentSortKey } = res.Item as { playerId: string; paymentSortKey: string };
  const pay = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `PLAYER#${playerId}`, SK: paymentSortKey } }),
  );
  if (!pay.Item) return null;
  return { playerId, paymentSortKey, payment: pay.Item as Payment };
}

async function settleByToken(token: string, outcome: 'confirmed' | 'denied') {
  const r = await resolveToken(token);
  if (!r) return 'gone' as const;
  if (r.payment.status !== 'pending') return 'already' as const;
  const res = await settle(r.playerId, r.paymentSortKey, r.payment, outcome, keys.token(token));
  return res === 'done' ? outcome : ('already' as const);
}
export const confirmPayment = (token: string) => settleByToken(token, 'confirmed');
export const denyPayment = (token: string) => settleByToken(token, 'denied');

// ─────────────────────────────── Card ──────────────────────────────────────
export async function createCardPayment(input: { playerId: string; playerName: string; plan?: Plan }) {
  const paymentId = newId();
  const purchase = purchaseFor(input.plan, AMOUNTS.card);
  const session = await createCheckoutSession({
    paymentId,
    playerId: input.playerId,
    playerName: input.playerName,
    amountCents: purchase.amountCents,
    productName: input.plan
      ? `Oakhurst Basketball ${input.plan === 'year' ? 'year' : 'quarter'} pass`
      : 'Oakhurst Basketball credit',
    productDescription: input.plan
      ? `${purchase.periodLabel} for ${input.playerName}`
      : `Account credit for ${input.playerName}`,
    baseUrl: baseUrl(),
  });
  const { payment } = await writePending({
    paymentId,
    playerId: input.playerId,
    purchase,
    method: 'card',
    stripeSessionId: session.id,
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
    await settle(playerId, sortKey, payment, 'confirmed');
    return 'confirmed';
  }
  if (s.payment_status === 'paid' && !matches) {
    console.error('stripe session mismatch', { paymentId, session: s.id, amount: s.amount_total });
    return 'pending';
  }
  if (s.status === 'expired') {
    await settle(playerId, sortKey, payment, 'expired');
    return 'expired';
  }
  return 'pending';
}

/** Admin queue. */
export async function listPending(): Promise<Payment[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: GSI1,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'PAYMENT_STATUS#pending' },
    }),
  );
  return (res.Items ?? []) as Payment[];
}
