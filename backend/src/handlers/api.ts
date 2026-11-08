// Main API router.
//   /api/kiosk/*   kiosk device token (x-kiosk-device + x-kiosk-token)
//   /api/stripe/*  public: Stripe return page + webhook (both verified with Stripe)
//   /api/*         Cognito JWT (player / admin)
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  ok,
  created,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  serverError,
  json,
  parseBody,
  getClaims,
  isAdmin,
  routePath,
  method,
} from '../lib/http.js';
import {
  getPlayer,
  getPlayerByCognitoSub,
  listPlayersPage,
  negativeFlags,
  checkinStats,
  listAdmins,
  getAdmin,
  createPlayer,
  createAdmin,
  adminAdjustBalance,
  MAX_ADJUST_CENTS,
  pinLocked,
  recordPinFailure,
  clearPinFailures,
  linkAdminSub,
  setPlayerPin,
  setPlayerContact,
  playerCheckins,
  playerPayments,
  createKiosk,
  listKiosks,
  deleteKiosk,
  setPlayerApproved,
  clubDate,
  listAdminsDetailed,
  setAdminEmail,
} from '../lib/repo.js';

import { ddb, TABLE, keys } from '../lib/ddb.js';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { verifySecret, hashSecret, hashToken, verifyToken } from '../lib/crypto.js';
import { cleanEmail, cleanName, isId, isPin } from '../lib/text.js';
import { checkContact, hasContact, normalizePhone } from '../lib/contact.js';
import { BadCursor, pageLimit } from '../lib/page.js';
import type { Player } from '../lib/types.js';
import {
  AMOUNTS,
  createCashPayment,
  createCardPayment,
  syncCardPayment,
  getPayment,
  listPendingPage,
  adminSettle,
  PaymentRefused,
  reverseCardPayment,
} from '../lib/payments.js';
import {
  StripeNotConfigured,
  stripeEnabled,
  webhookSecret,
  retrieveCheckoutSession,
  verifyWebhookSignature,
  paymentIdForIntent,
} from '../lib/stripe.js';
import {
  NEGATIVE_LIMIT_CENTS,
  currentSession,
  openSession,
  closeSession,
  getSession,
  listSessions,
  sessionAttendees,
  sessionCheckIn,
  isCheckedIn,
  isOpen,
  endedAt,
  refundCurrentSessionFee,
  setFreeDay,
  type CheckInResult,
} from '../lib/sessions.js';
import { isPlan, type Plan } from '../lib/plans.js';
import {
  checkSubscription,
  deleteSubscription,
  saveSubscription,
  sendPush,
  toUser,
  vapidPublicKey,
} from '../lib/push.js';
import { cashCreditCents } from '../lib/cash.js';
import { addExpense, checkExpense, deleteExpense, expenseReport, updateExpense } from '../lib/expenses.js';
import { RULES, WAIVER, checkSignature, isCurrent, recordAgreements } from '../lib/agreements.js';
import {
  DEFAULT_ANNOUNCEMENT,
  cleanText,
  currentAnnouncement,
  editAnnouncement,
  postAnnouncement,
  removeAnnouncement,
  setRsvp,
} from '../lib/announce.js';
import { activeNotices, checkNotice, editNotice, postNotice, removeNotice, MAX_ACTIVE_NOTICES } from '../lib/notices.js';
import {
  changesSince,
  checkUpload,
  deleteMessage,
  getChatPrefs,
  latestMessage,
  listMessages,
  markChatSeen,
  mediaUrl,
  notifyChat,
  postMessage,
  react,
  setChatNotify,
  uploadTicket,
} from '../lib/chat.js';
import {
  coveringPass,
  purchasable,
  currentPassHolders,
  grantPass,
  playerPasses,
  type Pass,
} from '../lib/passes.js';

/** Payment choices: drop-in credit amounts plus the quarter/year passes on offer. */
const payOptions = async (current: Pass | null) => ({
  cardCents: AMOUNTS.card,
  cashCents: AMOUNTS.cash,
  cardEnabled: await stripeEnabled(),
  plans: purchasable(current),
});

const passView = (p: Pass | null) =>
  p ? { plan: p.plan, label: p.label, start: p.start, end: p.end } : null;

/** Refuse to sell a pass the player already holds (or a quarter on top of a year). */
/**
 * Why this pass can't be sold right now, or null. `asAdmin` lets an admin record
 * a year pass after Q1 (e.g. one paid in June but entered in July); the
 * "already covered" check still applies.
 */
async function planBlocked(playerId: string, plan: Plan, asAdmin = false): Promise<string | null> {
  const offer = purchasable(await coveringPass(playerId)).find((o) => o.plan === plan)!;
  if (offer.status === 'owned') return `You already have a pass for ${offer.label}`;
  if (offer.status === 'covered') return 'Your year pass already covers this quarter';
  if (offer.status === 'not_offered' && !asAdmin) {
    return 'The year pass is only available Apr 1 – Jun 30. Buy a quarter pass instead.';
  }
  return null;
}

/** Shared check-in response for the kiosk and the player page. */
async function checkInResponse(name: string, r: CheckInResult) {
  if (r.result === 'no_session') return ok({ result: 'no_session', name });
  const base = {
    result: r.result,
    name,
    balanceCents: r.balanceCents,
    owes: r.balanceCents < 0 ? -r.balanceCents : 0,
    limitCents: NEGATIVE_LIMIT_CENTS,
    pass: passView(r.pass),
    options: await payOptions(r.pass),
  };
  if (r.result === 'limit' || r.result === 'needs_payment') {
    return ok({
      ...base,
      feeCents: AMOUNTS.dailyFee,
      // Balance after today's fee if they defer payment.
      balanceAfterCents: r.balanceCents - AMOUNTS.dailyFee,
      needCents: Math.max(0, r.minBalanceCents - r.balanceCents),
    });
  }
  return ok({ ...base, feeCents: r.feeCents, freeDay: !!r.session.free && !r.pass });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const path = routePath(event);
    const m = method(event);

    if (m === 'OPTIONS') return ok({});

    // Kiosk lives at /api/kiosk/* (no JWT; device token). Strip the /api prefix so
    // the kiosk router keeps matching on /kiosk/... paths.
    // `return await` so rejections land in the catch below.
    if (path.startsWith('/api/kiosk/')) return await kioskRouter(event, path.slice(4), m);
    if (path.startsWith('/api/stripe/')) return await stripeRouter(event, path, m);
    if (path.startsWith('/api/media/')) return await mediaRouter(path, m);
    if (path.startsWith('/api/')) return await apiRouter(event, path, m);
    return notFound();
  } catch (err) {
    if (err instanceof StripeNotConfigured) return json(503, { error: err.message });
    if (err instanceof PaymentRefused) return json(409, { error: err.message });
    if (err instanceof BadCursor) return badRequest(err.message);
    console.error('handler error', err);
    return serverError();
  }
};

// ─────────────────────────── Stripe (public) ────────────────────────────────
// Neither route trusts the caller: both re-read the session from Stripe before
// anything is credited (syncCardPayment).
async function stripeRouter(
  event: APIGatewayProxyEventV2,
  path: string,
  m: string,
): Promise<APIGatewayProxyResultV2> {
  // GET /api/stripe/return?session_id=cs_...  — the payer's phone lands here.
  if (path === '/api/stripe/return' && m === 'GET') {
    const sessionId = event.queryStringParameters?.session_id ?? '';
    let s;
    try {
      s = await retrieveCheckoutSession(sessionId);
    } catch (err) {
      if (err instanceof StripeNotConfigured) throw err;
      return notFound('Payment not found'); // unknown or malformed session id
    }
    const paymentId = s.metadata?.paymentId;
    if (!paymentId) return notFound('Payment not found');
    const status = await syncCardPayment(paymentId);
    return ok({ status, amountCents: s.amount_total });
  }

  // POST /api/stripe/webhook — optional backstop if the payer closes the page.
  if (path === '/api/stripe/webhook' && m === 'POST') {
    const secret = await webhookSecret();
    if (!secret) return json(503, { error: 'webhook not configured' });
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    const sig = event.headers?.['stripe-signature'] ?? '';
    if (!verifyWebhookSignature(raw, sig, secret)) return badRequest('bad signature');
    const evt = JSON.parse(raw);
    if (
      evt.type === 'checkout.session.completed' ||
      evt.type === 'checkout.session.async_payment_succeeded' ||
      evt.type === 'checkout.session.expired'
    ) {
      const paymentId = evt.data?.object?.metadata?.paymentId;
      if (isId(paymentId)) await syncCardPayment(paymentId);
    }
    // Money went back to the card: take back what it bought and tell the admins.
    // A partial refund is left to the admins (they chose the amount in Stripe).
    const obj = evt.data?.object ?? {};
    const fullRefund = evt.type === 'charge.refunded' && obj.refunded === true;
    if (fullRefund || evt.type === 'charge.dispute.created') {
      const paymentId = typeof obj.payment_intent === 'string' ? await paymentIdForIntent(obj.payment_intent) : null;
      if (paymentId) await reverseCardPayment(paymentId, fullRefund ? 'refunded' : 'disputed');
    }
    return ok({ received: true });
  }

  return notFound();
}

// ─────────────────────────── Kiosk routes ───────────────────────────────────
const KIOSK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;
// Guarded by the x-kiosk-token header validated against a KIOSK# record.
async function kioskRouter(
  event: APIGatewayProxyEventV2,
  path: string,
  m: string,
): Promise<APIGatewayProxyResultV2> {
  const token = event.headers?.['x-kiosk-token'] ?? event.headers?.['X-Kiosk-Token'];
  const deviceId = event.headers?.['x-kiosk-device'] ?? event.headers?.['X-Kiosk-Device'];
  if (!token || !deviceId) return unauthorized('missing kiosk credentials');
  // One answer for "no such kiosk" and "wrong token", so device ids can't be probed.
  if (!KIOSK_ID_RE.test(deviceId) || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return unauthorized('bad kiosk token');

  const dev = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: keys.kioskProfile(deviceId) }),
  );
  const stored = String((dev.Item as any)?.deviceSecretHash ?? '');
  if (!dev.Item || !(dev.Item as any).active) return unauthorized('bad kiosk token');
  if (stored.startsWith('sha256:')) {
    if (!verifyToken(token, stored)) return unauthorized('bad kiosk token');
  } else {
    // Kiosk paired before tokens were hashed with SHA-256: check the old scrypt
    // hash once, then store the fast hash so later requests skip scrypt.
    if (!verifySecret(token, stored)) return unauthorized('bad kiosk token');
    await ddb
      .send(
        new UpdateCommand({
          TableName: TABLE,
          Key: keys.kioskProfile(deviceId),
          UpdateExpression: 'SET deviceSecretHash = :h',
          ConditionExpression: 'deviceSecretHash = :old',
          ExpressionAttributeValues: { ':h': hashToken(token), ':old': stored },
        }),
      )
      .catch((e) => console.warn('kiosk hash upgrade skipped', e?.name));
  }

  /**
   * The player behind a kiosk request, after checking their PIN. Too many wrong
   * PINs lock the player for a while (see pinLocked), so PINs can't be guessed.
   */
  async function kioskPlayer(b: any): Promise<{ player: Player } | { res: APIGatewayProxyResultV2 }> {
    if (!isId(b.playerId) || b.pin == null || b.pin === '') return { res: badRequest('playerId and pin required') };
    const player = await getPlayer(b.playerId);
    if (!player) return { res: notFound('Player not found') };
    const locked = await pinLocked(player.playerId);
    if (locked) {
      const when = locked === 'day' ? 'later' : 'in 15 minutes';
      return {
        res: json(429, { error: `Too many wrong PINs. Try again ${when}, or set a new PIN in the app under Kiosk PIN.` }),
      };
    }
    if (!isPin(b.pin) || !player.pinHash || !verifySecret(String(b.pin), player.pinHash)) {
      await recordPinFailure(player.playerId);
      return { res: unauthorized('wrong PIN') };
    }
    await clearPinFailures(player.playerId).catch(() => {});
    return { player };
  }

  // GET /kiosk/players?cursor= — picker list, A–Z, one page at a time (the kiosk
  // follows nextCursor). Only a negative-balance flag, no amounts.
  if (path === '/kiosk/players' && m === 'GET') {
    const qs = event.queryStringParameters ?? {};
    const r = await listPlayersPage(qs.cursor, pageLimit(qs.limit, 200, 500));
    return ok({
      players: r.players.map((p) => ({ playerId: p.playerId, name: p.name, negative: p.balanceCents < 0 })),
      nextCursor: r.nextCursor,
    });
  }

  // GET /kiosk/session — the open session (or null) and who is checked in.
  if (path === '/kiosk/session' && m === 'GET') {
    const session = await currentSession();
    if (!session) return ok({ session: null, attendees: [] });
    const attendees = await sessionAttendees(session.sessionId);
    // Only the attendees' balances, not every player's.
    const negative = await negativeFlags(attendees.map((a) => a.playerId));
    return ok({
      session,
      attendees: attendees.map((a) => ({
        playerId: a.playerId,
        name: a.name,
        at: a.at,
        negative: negative.get(a.playerId) ?? false,
      })),
    });
  }

  // GET /kiosk/admins — cash-recipient picker
  if (path === '/kiosk/admins' && m === 'GET') {
    return ok({ admins: await listAdmins() });
  }

  // POST /kiosk/checkin  { playerId, pin }
  // Checks into the open session and charges the fee once per session.
  // result: checked_in | already | limit (pay first) | no_session
  if (path === '/kiosk/checkin' && m === 'POST') {
    const k = await kioskPlayer(parseBody(event));
    if ('res' in k) return k.res;
    const { player } = k;
    // No check-in until the current waiver + club rules are signed (they can
    // sign right here on the kiosk: POST /kiosk/agreements).
    if (!isCurrent(player as any)) {
      return ok({ result: 'needs_agreement', name: player.name, signedBefore: !!(player as any).agreedAt });
    }
    const { mode } = parseBody(event);
    const r = await sessionCheckIn(player, AMOUNTS.dailyFee, 'kiosk', mode === 'defer' ? 'defer' : 'auto');
    return checkInResponse(player.name, r);
  }

  // GET /kiosk/agreements — the waiver + rules text to show for signing
  if (path === '/kiosk/agreements' && m === 'GET') {
    return ok({ waiver: WAIVER, rules: RULES });
  }

  // POST /kiosk/agreements { playerId, pin, waiverVersion, rulesVersion, agreeRules,
  //                          agreeWaiver, signedName, adult, guardianName? }
  // A player signs on the kiosk (e.g. one an admin added who never uses the app).
  if (path === '/kiosk/agreements' && m === 'POST') {
    const b = parseBody(event);
    const k = await kioskPlayer(b);
    if ('res' in k) return k.res;
    const { player } = k;
    const { sig, error } = checkSignature(b);
    if (error) return badRequest(error);
    const agreedAt = await recordAgreements(player.playerId, sig!, {
      sub: `kiosk:${deviceId}`,
      ip: event.requestContext?.http?.sourceIp,
      userAgent: event.requestContext?.http?.userAgent,
    });
    return ok({ current: true, agreedAt });
  }

  // POST /kiosk/pay  { playerId, pin, method: 'card' | 'cash', adminId?, plan? }
  // plan 'quarter' | 'year' buys a pass; no plan buys drop-in credit.
  // Amounts are fixed server-side; the kiosk never sends one.
  if (path === '/kiosk/pay' && m === 'POST') {
    const body = parseBody(event);
    const { method: pm, adminId, plan: rawPlan, amountCents: rawAmount } = body;
    if (pm !== 'card' && pm !== 'cash') return badRequest('Choose card or cash');
    if (rawPlan != null && !isPlan(rawPlan)) return badRequest('Choose a quarter pass or a year pass');
    const plan = (rawPlan ?? undefined) as Plan | undefined;
    const k = await kioskPlayer(body);
    if ('res' in k) return k.res;
    const { player } = k;
    const playerId = player.playerId;
    if (plan) {
      const blocked = await planBlocked(playerId, plan);
      if (blocked) return json(409, { error: blocked });
    }

    if (pm === 'card') {
      const { payment, checkoutUrl } = await createCardPayment({
        playerId,
        playerName: player.name,
        plan,
        email: player.email,
      });
      return created({ paymentId: payment.paymentId, amountCents: payment.amountCents, checkoutUrl });
    }

    if (!isId(adminId)) return badRequest('Pick who you handed the cash to');
    const credit = plan ? AMOUNTS.cash : cashCreditCents(rawAmount, AMOUNTS.cash);
    if (typeof credit === 'string') return badRequest(credit);
    const admin = await getAdmin(adminId);
    if (!admin || !admin.active) return notFound('Admin not found');
    const { payment, notified } = await createCashPayment({
      playerId,
      playerName: player.name,
      adminId,
      adminEmail: admin.email,
      plan,
      creditCents: credit,
    });
    return created({
      paymentId: payment.paymentId,
      amountCents: payment.amountCents,
      adminName: admin.name,
      notified,
    });
  }

  // GET /kiosk/payments/{paymentId} — the kiosk polls this while showing the QR.
  const payMatch = path.match(/^\/kiosk\/payments\/([a-f0-9]{24})$/);
  if (payMatch && m === 'GET') {
    const found = await getPayment(payMatch[1]);
    if (!found) return notFound('Payment not found');
    const status =
      found.payment.method === 'card' ? await syncCardPayment(payMatch[1]) : found.payment.status;
    const player = await getPlayer(found.playerId);
    return ok({
      status,
      amountCents: found.payment.amountCents,
      balanceCents: player?.balanceCents ?? 0,
      plan: found.payment.plan ?? null,
      periodLabel: found.payment.periodLabel ?? null,
    });
  }

  return notFound();
}

// ─────────────────────────── Chat images (public) ────────────────────────────
// <img> tags can't send a token, so this route is public. The path holds a random
// 96-bit id, and it only ever redirects to a signed URL that expires in an hour.
async function mediaRouter(path: string, m: string): Promise<APIGatewayProxyResultV2> {
  if (m !== 'GET') return notFound();
  const url = await mediaUrl(path.slice('/api/media/'.length));
  if (!url) return notFound();
  return { statusCode: 302, headers: { location: url, 'cache-control': 'private, max-age=3000' }, body: '' };
}

const CURSOR_RE = /^MSG#\d{4}-\d\d-\d\dT[\d:.]+Z#[a-f0-9]{24}$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;

/** Chat + announcements: everything a signed-in member does together. */
async function communityRouter(
  event: APIGatewayProxyEventV2,
  path: string,
  m: string,
  claims: NonNullable<ReturnType<typeof getClaims>>,
  admin: boolean,
): Promise<APIGatewayProxyResultV2 | null> {
  // ── Announcement ──
  // GET  /api/announcement                     today's announcement + RSVPs (or null)
  // POST /api/announcement/rsvp {announceId, status: in|out|null}
  if (path === '/api/announcement' && m === 'GET') {
    const a = await currentAnnouncement();
    const player = await getPlayerByCognitoSub(claims.sub);
    return ok({
      announcement: a,
      defaultText: DEFAULT_ANNOUNCEMENT,
      myPlayerId: player?.playerId ?? null,
    });
  }
  if (path === '/api/announcement/rsvp' && m === 'POST') {
    const { announceId, status } = parseBody(event);
    if (status !== 'in' && status !== 'maybe' && status !== 'out' && status !== null) {
      return badRequest("status must be 'in', 'maybe', 'out' or null");
    }
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    const done = await setRsvp(String(announceId ?? ''), { playerId: player.playerId, name: player.name }, status);
    if (!done) return json(409, { error: 'That announcement has expired or been replaced' });
    return ok({ announcement: await currentAnnouncement() });
  }

  // ── Chat ── members only: an admin approves each sign-up first.
  if (path.startsWith('/api/chat') && !admin) {
    const me = await getPlayerByCognitoSub(claims.sub);
    if (!me?.approved) {
      return json(403, { error: 'not_approved', message: 'An admin needs to approve your account before you can use the chat.' });
    }
  }
  // GET  /api/chat                       newest page
  // GET  /api/chat?before=<cursor>       older page
  // GET  /api/chat?after=<cursor>&since=<iso>   poll: new messages + deletions
  // POST /api/chat {text?, imageKey?, width?, height?}
  // POST /api/chat/upload {contentType, size}  → presigned POST for one image
  // POST /api/chat/delete {cursor}
  // GET/PUT /api/chat/prefs {chatNotify}
  if (path === '/api/chat' && m === 'GET') {
    const q = event.queryStringParameters ?? {};
    const now = new Date().toISOString();
    await markChatSeen(claims.sub);
    if (q.after) {
      if (!CURSOR_RE.test(q.after) || !ISO_RE.test(q.since ?? '')) return badRequest('Couldn’t load the chat. Reload and try again.');
      return ok({ ...(await changesSince(q.after, q.since!)), now });
    }
    if (q.before && !CURSOR_RE.test(q.before)) return badRequest('Couldn’t load the chat. Reload and try again.');
    return ok({ ...(await listMessages(q.before)), now, mySub: claims.sub });
  }
  if (path === '/api/chat' && m === 'POST') {
    const b = parseBody(event);
    const player = await getPlayerByCognitoSub(claims.sub);
    const name = player?.name || claims.name || claims.email?.split('@')[0] || 'Member';
    const r = await postMessage({
      sub: claims.sub,
      name,
      text: typeof b.text === 'string' ? b.text : undefined,
      imageKey: b.imageKey,
      width: b.width,
      height: b.height,
      replyTo: b.replyTo,
    });
    if (r.error) return badRequest(r.error);
    await notifyChat(r.message!, r.repliedTo).catch((e) => console.error('chat notify failed', e));
    return created({ message: r.message });
  }
  // POST /api/chat/react {cursor, emoji, on} — add/remove your reaction
  if (path === '/api/chat/react' && m === 'POST') {
    const b = parseBody(event);
    if (typeof b.on !== 'boolean') return badRequest('on must be true or false');
    const r = await react(b.cursor, b.emoji, b.on, claims.sub);
    if (r.error === 'notfound') return notFound('That message was deleted');
    if (r.error) return badRequest(r.error);
    return ok({ message: r.message });
  }
  if (path === '/api/chat/upload' && m === 'POST') {
    const { contentType, size } = parseBody(event);
    const bad = checkUpload(contentType, size);
    if (bad) return badRequest(bad);
    const t = await uploadTicket(claims.sub, String(contentType));
    if ('error' in t) return json(429, { error: t.error });
    return ok(t);
  }
  if (path === '/api/chat/delete' && m === 'POST') {
    const { cursor } = parseBody(event);
    const r = await deleteMessage(String(cursor ?? ''), { sub: claims.sub, isAdmin: admin });
    if (r === 'notfound') return notFound('Message not found');
    if (r === 'forbidden') return forbidden();
    return ok({ deleted: true });
  }
  // GET /api/chat/latest → { cursor, mine } for the unread dot (doesn't count as "seen")
  if (path === '/api/chat/latest' && m === 'GET') {
    const l = await latestMessage();
    return ok({ cursor: l?.cursor ?? null, mine: l ? l.sub === claims.sub : false });
  }
  if (path === '/api/chat/prefs' && m === 'GET') return ok(await getChatPrefs(claims.sub));
  if (path === '/api/chat/prefs' && m === 'PUT') {
    const { chatNotify } = parseBody(event);
    if (typeof chatNotify !== 'boolean') return badRequest('chatNotify must be true or false');
    await setChatNotify(claims.sub, chatNotify);
    return ok({ chatNotify });
  }
  return null;
}

// ──────────────────────── Authenticated routes ──────────────────────────────
async function apiRouter(
  event: APIGatewayProxyEventV2,
  path: string,
  m: string,
): Promise<APIGatewayProxyResultV2> {
  const claims = getClaims(event);
  if (!claims) return unauthorized();
  const admin = isAdmin(claims);

  // GET /api/notices — club notices showing today (any signed-in member)
  if (path === '/api/notices' && m === 'GET') {
    return ok({ notices: await activeNotices() });
  }

  if (path.startsWith('/api/chat') || path.startsWith('/api/announcement')) {
    const r = await communityRouter(event, path, m, claims, admin);
    if (r) return r;
  }

  // GET /api/me — profile + role (+ linked player)
  if (path === '/api/me' && m === 'GET') {
    // Link this admin's record to their account (once), so admin pushes and
    // self-payment checks go by account rather than by email.
    if (admin && claims.emailVerified && claims.email) {
      await linkAdminSub(claims.email, claims.sub).catch((e) => console.warn('admin link failed', e?.name));
    }
    const player = await getPlayerByCognitoSub(claims.sub);
    return ok({
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      roles: claims.groups,
      isAdmin: admin,
      player: player
        ? { playerId: player.playerId, name: player.name, balanceCents: player.balanceCents }
        : null,
    });
  }

  // GET /api/me/balance — the signed-in player's own balance + history
  if (path === '/api/me/balance' && m === 'GET') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    // First page of each history list; more via /api/me/checkins and /api/me/payments.
    const [c, p, passes, stats] = await Promise.all([
      playerCheckins(player.playerId),
      playerPayments(player.playerId),
      playerPasses(player.playerId),
      checkinStats(player),
    ]);
    return ok({
      playerId: player.playerId,
      name: player.name,
      balanceCents: player.balanceCents,
      owes: player.balanceCents < 0 ? -player.balanceCents : 0,
      checkins: c.checkins,
      checkinsCursor: c.nextCursor,
      payments: p.payments,
      paymentsCursor: p.nextCursor,
      contact: {
        phone: player.phone ?? null,
        emergencyName: (player as any).emergencyName ?? null,
        emergencyPhone: (player as any).emergencyPhone ?? null,
      },
      checkinCount: stats.checkinCount,
      checkinsByMonth: stats.byMonth,
      passes: passes.map(passView),
    });
  }

  // GET /api/me/checkins?cursor=  /  GET /api/me/payments?cursor= — older history
  if ((path === '/api/me/checkins' || path === '/api/me/payments') && m === 'GET') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    const qs = event.queryStringParameters ?? {};
    const opts = { cursor: qs.cursor, limit: pageLimit(qs.limit, 25, 100) };
    return ok(path === '/api/me/checkins' ? await playerCheckins(player.playerId, opts) : await playerPayments(player.playerId, opts));
  }

  // GET /api/me/session — the open session and this player's status in it
  if (path === '/api/me/session' && m === 'GET') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    const session = await currentSession();
    const [checkedIn, pass] = await Promise.all([
      session ? isCheckedIn(session.sessionId, player.playerId) : Promise.resolve(false),
      coveringPass(player.playerId, session?.eventDate),
    ]);
    const freeDay = !!session?.free;
    const feeCents = pass || freeDay ? 0 : AMOUNTS.dailyFee;
    const minBalance = feeCents - NEGATIVE_LIMIT_CENTS;
    // covered: pass · free: free day · credit: balance pays the fee · owe: may pay next time · blocked: must pay first
    const payState = pass
      ? 'covered'
      : freeDay
        ? 'free'
        : player.balanceCents >= feeCents
        ? 'credit'
        : player.balanceCents >= minBalance
          ? 'owe'
          : 'blocked';
    return ok({
      payState,
      session,
      checkedIn,
      balanceCents: player.balanceCents,
      feeCents,
      limitCents: NEGATIVE_LIMIT_CENTS,
      pass: passView(pass),
      canCheckIn: !!session && !checkedIn && (!!pass || freeDay || player.balanceCents >= minBalance),
      needCents: pass || freeDay ? 0 : Math.max(0, minBalance - player.balanceCents),
      options: await payOptions(pass),
    });
  }

  // POST /api/me/checkin — check in to the open session from the player page
  if (path === '/api/me/checkin' && m === 'POST') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    if (!isCurrent(player as any)) {
      return ok({ result: 'needs_agreement', name: player.name, signedBefore: !!(player as any).agreedAt });
    }
    const { mode } = parseBody(event);
    const r = await sessionCheckIn(player, AMOUNTS.dailyFee, 'player', mode === 'defer' ? 'defer' : 'auto');
    return checkInResponse(player.name, r);
  }

  // POST /api/me/pay-card { plan? } — Stripe Checkout from the player page:
  // no plan = $20 credit, 'quarter' / 'year' = pass for the current period.
  if (path === '/api/me/pay-card' && m === 'POST') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    const { plan: rawPlan } = parseBody(event);
    if (rawPlan != null && !isPlan(rawPlan)) return badRequest('Choose a quarter pass or a year pass');
    const plan = (rawPlan ?? undefined) as Plan | undefined;
    if (plan) {
      const blocked = await planBlocked(player.playerId, plan);
      if (blocked) return json(409, { error: blocked });
    }
    const { payment, checkoutUrl } = await createCardPayment({
      playerId: player.playerId,
      playerName: player.name,
      plan,
      email: player.email || claims.email,
    });
    return created({ paymentId: payment.paymentId, amountCents: payment.amountCents, checkoutUrl });
  }

  // GET /api/me/admins — who a player can hand cash to
  if (path === '/api/me/admins' && m === 'GET') {
    return ok({ admins: await listAdmins() });
  }

  // POST /api/me/pay-cash { adminId, plan? } — cash from the player page; the
  // chosen admin confirms by email (or on the Admin page), same as the kiosk.
  if (path === '/api/me/pay-cash' && m === 'POST') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    const { adminId, plan: rawPlan, amountCents: rawAmount } = parseBody(event);
    if (rawPlan != null && !isPlan(rawPlan)) return badRequest('Choose a quarter pass or a year pass');
    const plan = (rawPlan ?? undefined) as Plan | undefined;
    if (!isId(adminId)) return badRequest('Pick who you handed the cash to');
    const credit = plan ? AMOUNTS.cash : cashCreditCents(rawAmount, AMOUNTS.cash);
    if (typeof credit === 'string') return badRequest(credit);
    const adm = await getAdmin(adminId);
    if (!adm || !adm.active) return notFound('Admin not found');
    if (plan) {
      const blocked = await planBlocked(player.playerId, plan);
      if (blocked) return json(409, { error: blocked });
    }
    const { payment, notified } = await createCashPayment({
      playerId: player.playerId,
      playerName: player.name,
      adminId: adm.adminId,
      adminEmail: adm.email,
      plan,
      creditCents: credit,
    });
    return created({ paymentId: payment.paymentId, amountCents: payment.amountCents, adminName: adm.name, notified });
  }

  // ── Notifications (Web Push) ──
  // GET    /api/me/push              → { publicKey }  (VAPID key for pushManager.subscribe)
  // POST   /api/me/push { subscription }  register this device (idempotent)
  // DELETE /api/me/push { endpoint }      unregister (sign-out / turn off)
  // POST   /api/me/push/test              send a test to the caller's devices
  if (path === '/api/me/push' && m === 'GET') {
    const publicKey = await vapidPublicKey();
    if (!publicKey) return json(503, { error: 'Notifications are not set up yet' });
    return ok({ publicKey });
  }
  if (path === '/api/me/push' && m === 'POST') {
    const { subscription } = parseBody(event);
    const bad = checkSubscription(subscription);
    if (bad) {
      console.warn('rejected push subscription:', bad);
      return badRequest('Couldn’t turn on notifications on this device. Try again or use a different browser.');
    }
    const player = await getPlayerByCognitoSub(claims.sub);
    await saveSubscription(subscription, {
      sub: claims.sub,
      email: claims.emailVerified ? claims.email : undefined,
      playerId: player?.playerId,
      isAdmin: admin,
    });
    return ok({ subscribed: true });
  }
  if (path === '/api/me/push' && m === 'DELETE') {
    const { endpoint } = parseBody(event);
    if (!endpoint) return badRequest('Couldn’t turn on notifications on this device. Try again or use a different browser.');
    return ok({ removed: await deleteSubscription(String(endpoint), claims.sub) });
  }
  if (path === '/api/me/push/test' && m === 'POST') {
    const r = await sendPush(toUser(claims.sub), {
      title: 'Notifications are on',
      body: "You’ll get a heads-up when the gym opens, announcements are posted, and payments are confirmed.",
      url: admin ? '/admin' : '/player',
      tag: 'test',
    });
    return ok(r);
  }

  // ── Waiver + club rules ──
  // GET  /api/me/agreements → { waiver, rules, current, signed }
  // POST /api/me/agreements { waiverVersion, rulesVersion, agreeRules, agreeWaiver,
  //                           signedName, adult, guardianName? }
  if (path === '/api/me/agreements' && m === 'GET') {
    const player = await getPlayerByCognitoSub(claims.sub);
    return ok({
      waiver: WAIVER,
      rules: RULES,
      hasPlayer: !!player,
      // Phone + emergency contact: the app asks for them once if missing.
      contact: player
        ? { phone: player.phone ?? null, emergencyName: (player as any).emergencyName ?? null, emergencyPhone: (player as any).emergencyPhone ?? null }
        : null,
      contactComplete: !player || hasContact(player),
      current: isCurrent(player as any),
      signed: player && (player as any).agreedAt
        ? {
            waiverVersion: (player as any).waiverVersion,
            rulesVersion: (player as any).rulesVersion,
            agreedAt: (player as any).agreedAt,
            signedName: (player as any).signedName,
          }
        : null,
    });
  }
  if (path === '/api/me/agreements' && m === 'POST') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    const { sig, error } = checkSignature(parseBody(event));
    if (error) return badRequest(error);
    const agreedAt = await recordAgreements(player.playerId, sig!, {
      sub: claims.sub,
      ip: event.requestContext?.http?.sourceIp,
      userAgent: event.requestContext?.http?.userAgent,
    });
    return ok({ current: true, agreedAt });
  }

  // PUT /api/me/contact { phone, emergencyName, emergencyPhone } — required details
  if (path === '/api/me/contact' && m === 'PUT') {
    const { contact, error } = checkContact(parseBody(event));
    if (error) return badRequest(error);
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    await setPlayerContact(player.playerId, contact!);
    return ok({ contact });
  }

  // POST /api/me/pin  { pin }  — player sets their own kiosk PIN
  if (path === '/api/me/pin' && m === 'POST') {
    const { pin } = parseBody(event);
    if (!/^\d{4,6}$/.test(String(pin ?? ''))) return badRequest('pin must be 4-6 digits');
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound("We couldn’t find your player profile. Sign out and back in, or ask an admin.");
    await setPlayerPin(player.playerId, hashSecret(String(pin)));
    await clearPinFailures(player.playerId).catch(() => {});
    return ok({ updated: true });
  }

  // ── Admin-only below ──
  if (!admin) return forbidden('Only admins can do this');

  // GET /api/admin/players?cursor= — a page of players (A–Z) with each one's pass
  // for the current period. The Admin page follows nextCursor to load them all.
  if (path === '/api/admin/players' && m === 'GET') {
    const qs = event.queryStringParameters ?? {};
    const [page, holders, admins] = await Promise.all([
      listPlayersPage(qs.cursor, pageLimit(qs.limit, 100, 200)),
      currentPassHolders(),
      listAdminsDetailed(),
    ]);
    const players = page.players;
    // Admins always have chat access, so they never need approving.
    const adminEmails = new Set(admins.map((a) => a.email?.toLowerCase()).filter(Boolean));
    return ok({
      players: players.map((p) => ({
        ...p,
        isAdmin: !!p.email && adminEmails.has(p.email.toLowerCase()),
        pass: passView(holders.get(p.playerId) ?? null),
      })),
      nextCursor: page.nextCursor,
      agreementVersions: { waiver: WAIVER.version, rules: RULES.version },
      plans: purchasable(null),
    });
  }

  // POST /api/admin/players/{id}/pass { plan } — record a pass paid outside the app
  const passMatch = path.match(/^\/api\/admin\/players\/([a-f0-9]{24})\/pass$/);
  if (passMatch && m === 'POST') {
    const { plan } = parseBody(event);
    if (!isPlan(plan)) return badRequest('Choose a quarter pass or a year pass');
    if (!(await getPlayer(passMatch[1]))) return notFound('Player not found');
    const blocked = await planBlocked(passMatch[1], plan, true);
    if (blocked) return json(409, { error: blocked });
    const p = await grantPass(passMatch[1], plan, claims.name || claims.email || 'Admin');
    if (!p) return json(409, { error: 'Pass already recorded' });
    const refundedCents = await refundCurrentSessionFee(passMatch[1], p);
    return created({ pass: passView(p), refundedCents });
  }

  // POST /api/admin/players  { name, email?, phone?, pin? }
  if (path === '/api/admin/players' && m === 'POST') {
    const { name: rawName, email: rawEmail, phone: rawPhone, pin } = parseBody(event);
    const name = cleanName(rawName);
    if (!name) return badRequest('Enter a name');
    const email = rawEmail == null || rawEmail === '' ? undefined : cleanEmail(rawEmail);
    if (email === null) return badRequest('That email address doesn’t look right');
    // Optional for players an admin adds (kiosk-only); if given, checked like sign-up.
    const b = parseBody(event);
    const given = (v: unknown) => typeof v === 'string' && v.trim() !== '';
    const phone = given(rawPhone) ? normalizePhone(rawPhone) : undefined;
    if (phone === null) return badRequest('That phone number doesn’t look right');
    const emergencyName = given(b.emergencyName) ? cleanName(b.emergencyName) : undefined;
    const emergencyPhone = given(b.emergencyPhone) ? normalizePhone(b.emergencyPhone) : undefined;
    if (emergencyPhone === null) return badRequest('That emergency contact number doesn’t look right');
    if (pin != null && pin !== '' && !isPin(pin)) return badRequest('PIN must be 4–6 digits');
    const player = await createPlayer({
      name,
      email,
      phone,
      emergencyName,
      emergencyPhone,
      pinHash: pin != null && pin !== '' ? hashSecret(String(pin)) : undefined,
      approved: true, // added by an admin, so already vouched for
    });
    return created({ player: { playerId: player.playerId, name: player.name } });
  }

  // POST /api/admin/players/{id}/approve { approved: boolean } — members-only access (chat)
  const approveMatch = path.match(/^\/api\/admin\/players\/([a-f0-9]{24})\/approve$/);
  if (approveMatch && m === 'POST') {
    const { approved } = parseBody(event);
    if (typeof approved !== 'boolean') return badRequest('approved must be true or false');
    const okd = await setPlayerApproved(approveMatch[1], approved, claims.name || claims.email || 'Admin');
    if (!okd) return notFound('Player not found');
    if (approved) {
      const p = await getPlayer(approveMatch[1]);
      if (p?.cognitoSub) {
        await sendPush(toUser(p.cognitoSub), {
          title: 'You’re approved!',
          body: 'An admin approved your account. You can now use the club chat.',
          url: '/chat',
          tag: 'approved',
        });
      }
    }
    return ok({ approved });
  }

  // POST /api/admin/players/{id}/charge  { amountCents, note? }
  // POST /api/admin/players/{id}/credit  { amountCents, note? }  (manual adj.)
  // Both are capped and leave an audit row (who, how much, note) on the player.
  const adjustMatch = path.match(/^\/api\/admin\/players\/([a-f0-9]{24})\/(charge|credit)$/);
  if (adjustMatch && m === 'POST') {
    const { amountCents, note } = parseBody(event);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return badRequest('Enter an amount greater than $0');
    }
    if (amountCents > MAX_ADJUST_CENTS) return badRequest(`Enter at most $${MAX_ADJUST_CENTS / 100} at a time`);
    const [, playerId, kind] = adjustMatch;
    const cleanNote = typeof note === 'string' ? cleanName(note, 200) : undefined;
    const balance = await adminAdjustBalance(
      playerId,
      kind === 'charge' ? -amountCents : amountCents,
      { sub: claims.sub, name: claims.name || claims.email || 'Admin' },
      cleanNote,
    );
    if (balance === null) return notFound('Player not found');
    return ok({ playerId, balanceCents: balance, note: cleanNote });
  }

  // GET /api/admin/pending?cursor= — payments awaiting confirmation, with names,
  // one page at a time (oldest first). Abandoned card checkouts are settled with
  // Stripe as they're seen, so they don't sit in the queue.
  if (path === '/api/admin/pending' && m === 'GET') {
    const qs = event.queryStringParameters ?? {};
    const page = await listPendingPage(qs.cursor, pageLimit(qs.limit, 50, 100));
    const stale = page.items.filter((p) => p.method === 'card' && Date.parse(p.createdAt) < Date.now() - 40 * 60_000).slice(0, 5);
    const settledNow = new Set<string>();
    await Promise.all(
      stale.map(async (p) => {
        const st = await syncCardPayment(p.paymentId).catch(() => 'pending');
        if (st !== 'pending') settledNow.add(p.paymentId);
      }),
    );
    const pending = page.items.filter((p) => !settledNow.has(p.paymentId));
    const playerIds = [...new Set(pending.map((p) => p.playerId))];
    const adminIds = [...new Set(pending.map((p) => p.adminId).filter(Boolean))] as string[];
    const [players, admins] = await Promise.all([
      Promise.all(playerIds.map((id) => getPlayer(id))),
      Promise.all(adminIds.map((id) => getAdmin(id))),
    ]);
    const pName = new Map(players.filter(Boolean).map((p) => [p!.playerId, p!.name]));
    const aName = new Map(admins.filter(Boolean).map((a) => [a!.adminId, a!.name]));
    return ok({
      pending: pending
        .map((p) => ({
          paymentId: p.paymentId,
          amountCents: p.amountCents,
          method: p.method,
          createdAt: p.createdAt,
          plan: p.plan ?? null,
          periodLabel: p.periodLabel ?? null,
          playerName: pName.get(p.playerId) ?? 'Unknown player',
          adminName: p.adminId ? (aName.get(p.adminId) ?? null) : null,
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      nextCursor: page.nextCursor,
    });
  }

  // POST /api/admin/payments/{id}/confirm | /deny — cash only
  const settleMatch = path.match(/^\/api\/admin\/payments\/([a-f0-9]{24})\/(confirm|deny)$/);
  if (settleMatch && m === 'POST') {
    const r = await adminSettle(settleMatch[1], settleMatch[2] === 'confirm' ? 'confirmed' : 'denied', {
      sub: claims.sub,
    });
    if (r === 'notfound') return notFound('Payment not found');
    if (r === 'self') return forbidden('You can’t confirm your own cash payment. Ask another admin to confirm it.');
    if (r === 'notcash') return badRequest('card payments are settled by Stripe');
    return ok({ result: r === 'already' ? 'already_handled' : settleMatch[2] === 'confirm' ? 'confirmed' : 'denied' });
  }

  // GET /api/admin/sessions — every session, newest first
  if (path === '/api/admin/sessions' && m === 'GET') {
    const now = new Date().toISOString();
    const qs = event.queryStringParameters ?? {};
    const { sessions, nextCursor } = await listSessions({ cursor: qs.cursor, limit: pageLimit(qs.limit, 25, 100) });
    return ok({
      nextCursor,
      sessions: sessions.map((s) => ({
        ...s,
        open: isOpen(s, now),
        endedAt: endedAt(s, now),
        autoClosed: !s.closedAt && s.closesAt <= now,
      })),
    });
  }

  // ── Expenses (admin) ──
  // GET  /api/admin/expenses?season=2026   season report (default: current season)
  // POST /api/admin/expenses {date, category, amountCents, note?}
  // POST /api/admin/expenses/update {cursor, date, category, amountCents, note?}
  // POST /api/admin/expenses/delete {cursor}
  if (path === '/api/admin/expenses' && m === 'GET') {
    const s = event.queryStringParameters?.season;
    if (s != null && !/^20\d\d$/.test(s)) return badRequest('season must be a year like 2026');
    return ok(await expenseReport(s ? Number(s) : undefined));
  }
  if (path === '/api/admin/expenses' && m === 'POST') {
    const { input, error } = checkExpense(parseBody(event), clubDate());
    if (error) return badRequest(error);
    return created({ expense: await addExpense(input!, { sub: claims.sub, name: claims.name || claims.email || 'Admin' }) });
  }
  if (path === '/api/admin/expenses/update' && m === 'POST') {
    const b = parseBody(event);
    const { input, error } = checkExpense(b, clubDate());
    if (error) return badRequest(error);
    const e = await updateExpense(String(b.cursor ?? ''), input!);
    return e ? ok({ expense: e }) : notFound('Expense not found');
  }
  if (path === '/api/admin/expenses/delete' && m === 'POST') {
    const { cursor } = parseBody(event);
    return (await deleteExpense(String(cursor ?? ''))) ? ok({ deleted: true }) : notFound('Expense not found');
  }

  // ── Announcement (admin) ──
  // POST   /api/admin/announcement {text}                  post today's (notifies everyone)
  // PUT    /api/admin/announcement {announceId, text, notify}  edit (RSVPs kept)
  // DELETE /api/admin/announcement {announceId}            take it down
  if (path === '/api/admin/announcement' && (m === 'POST' || m === 'PUT')) {
    const b = parseBody(event);
    const text = cleanText(b.text);
    if (!text) return badRequest('Announcement must be 1–280 characters');
    let a;
    if (m === 'POST') {
      a = await postAnnouncement(text, { sub: claims.sub, name: claims.name || claims.email || 'Admin' });
    } else {
      if (!(await editAnnouncement(String(b.announceId ?? ''), text))) {
        return json(409, { error: 'That announcement has expired or been replaced' });
      }
    }
    if (m === 'POST' || b.notify) {
      await sendPush((d) => d.sub !== claims.sub, {
        title: m === 'POST' ? 'Today at Oakhurst Basketball' : 'Updated: today at Oakhurst Basketball',
        body: text,
        url: '/player',
        tag: 'announcement',
      }, { urgency: 'high', ttlSeconds: 12 * 3600 });
    }
    return m === 'POST' ? created({ announcement: { ...a, rsvps: [] } }) : ok({ announcement: await currentAnnouncement() });
  }
  // ── Club notices (admin) ── plain messages, no RSVP, shown until a chosen day.
  // POST   /api/admin/notices {text, until, notify}
  // PUT    /api/admin/notices {noticeId, text, until, notify}
  // DELETE /api/admin/notices {noticeId}
  if (path === '/api/admin/notices' && (m === 'POST' || m === 'PUT')) {
    const b = parseBody(event);
    const { text, until, error } = checkNotice(b);
    if (error) return badRequest(error);
    let n;
    if (m === 'POST') {
      n = await postNotice(text!, until!, { sub: claims.sub, name: claims.name || claims.email || 'Admin' });
      if (n === 'full') {
        return json(409, { error: `Up to ${MAX_ACTIVE_NOTICES} notices can be up at once. Take one down first.` });
      }
    } else {
      if (!isId(b.noticeId)) return notFound('Notice not found');
      n = await editNotice(b.noticeId, text!, until!);
      if (!n) return notFound('That notice was taken down');
    }
    if (b.notify === true) {
      await sendPush((d) => d.sub !== claims.sub, {
        title: m === 'POST' ? 'Oakhurst Basketball' : 'Updated: Oakhurst Basketball',
        body: text!,
        url: '/player',
        tag: `notice-${n.noticeId}`,
      }, { ttlSeconds: 24 * 3600 });
    }
    return m === 'POST' ? created({ notice: n }) : ok({ notice: n });
  }
  if (path === '/api/admin/notices' && m === 'DELETE') {
    const { noticeId } = parseBody(event);
    return ok({ removed: isId(noticeId) ? await removeNotice(noticeId) : false });
  }

  if (path === '/api/admin/announcement' && m === 'DELETE') {
    const { announceId } = parseBody(event);
    return ok({ removed: await removeAnnouncement(String(announceId ?? '')) });
  }

  // POST /api/admin/sessions — open the gym (409 if a session is already open)
  if (path === '/api/admin/sessions' && m === 'POST') {
    const { free } = parseBody(event);
    const s = await openSession(claims.name || claims.email || 'Admin', free === true);
    if (!s) return json(409, { error: 'A session is already open' });
    const until = new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.CLUB_TZ ?? 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(s.closesAt));
    // Everyone with notifications on, except whoever just opened it.
    await sendPush((d) => d.sub !== claims.sub, {
      title: s.free ? 'Free day: the gym is open' : 'The gym is open',
      body: s.free
        ? `Free today. Pickup is open until about ${until}. Check in when you arrive.`
        : `Pickup is open until about ${until}. Check in when you arrive.`,
      url: '/player',
      tag: 'gym-open',
    }, { ttlSeconds: 2 * 3600 });
    return created({ session: s });
  }

  // GET /api/admin/sessions/{id} — one session with its attendees
  const sessMatch = path.match(/^\/api\/admin\/sessions\/([a-f0-9]{24})$/);
  if (sessMatch && m === 'GET') {
    const s = await getSession(sessMatch[1]);
    if (!s) return notFound('Session not found');
    const now = new Date().toISOString();
    return ok({
      session: { ...s, open: isOpen(s, now), endedAt: endedAt(s, now) },
      attendees: await sessionAttendees(s.sessionId),
    });
  }

  // POST /api/admin/sessions/{id}/free { free: boolean } — free day on/off for an
  // open session. Turning it on refunds anyone already charged for it.
  const freeMatch = path.match(/^\/api\/admin\/sessions\/([a-f0-9]{24})\/free$/);
  if (freeMatch && m === 'POST') {
    const { free } = parseBody(event);
    if (typeof free !== 'boolean') return badRequest('free must be true or false');
    const r = await setFreeDay(freeMatch[1], free);
    if (r.result === 'notfound') return notFound('Session not found');
    if (r.result === 'closed') return json(409, { error: 'That session is closed' });
    return ok({ session: r.session, refunded: r.refunded, refundedCents: r.refundedCents });
  }

  // POST /api/admin/sessions/{id}/close
  const closeMatch = path.match(/^\/api\/admin\/sessions\/([a-f0-9]{24})\/close$/);
  if (closeMatch && m === 'POST') {
    const r = await closeSession(closeMatch[1]);
    if (r === 'notfound') return notFound('Session not found');
    return ok({ result: r });
  }

  // GET /api/admin/admins
  if (path === '/api/admin/admins' && m === 'GET') {
    return ok({ admins: await listAdminsDetailed() });
  }

  // POST /api/admin/admins  { name, email }
  if (path === '/api/admin/admins' && m === 'POST') {
    const b = parseBody(event);
    const name = cleanName(b.name);
    if (!name || !b.email) return badRequest('Enter a name and an email');
    const email = cleanEmail(b.email);
    if (!email) return badRequest('That email address doesn’t look right');
    const a = await createAdmin({ name, email });
    return created({ admin: { adminId: a.adminId, name: a.name, email: a.email } });
  }

  // PUT /api/admin/admins/{id}/email  { email }
  const emailMatch = path.match(/^\/api\/admin\/admins\/([a-f0-9]{24})\/email$/);
  if (emailMatch && m === 'PUT') {
    const email = cleanEmail(parseBody(event).email);
    if (!email) return badRequest('That email address doesn’t look right');
    try {
      await setAdminEmail(emailMatch[1], email);
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') return notFound('Admin not found');
      throw err;
    }
    return ok({ updated: true });
  }

  // GET /api/admin/kiosks — provisioned kiosk devices (no secrets)
  if (path === '/api/admin/kiosks' && m === 'GET') {
    return ok({ kiosks: await listKiosks() });
  }

  // POST /api/admin/kiosks  { deviceId, label? }
  // Returns the one-time token to paste into the kiosk's /kiosk pairing screen.
  // Re-posting the same deviceId rotates (regenerates) its token.
  if (path === '/api/admin/kiosks' && m === 'POST') {
    const { deviceId, label } = parseBody(event);
    if (typeof deviceId !== 'string' || !KIOSK_ID_RE.test(deviceId)) {
      return badRequest('Device ID must be 2–64 letters, digits, "_" or "-", for example court-kiosk-1');
    }
    const result = await createKiosk(deviceId, typeof label === 'string' ? label : '');
    return created(result); // { deviceId, label, token } — token shown once
  }

  // DELETE /api/admin/kiosks/{deviceId} — remove a kiosk. Its token stops working
  // at once, and the kiosk goes back to its pairing screen on its next request.
  const kioskMatch = path.match(/^\/api\/admin\/kiosks\/([a-zA-Z0-9][a-zA-Z0-9_-]{1,63})$/);
  if (kioskMatch && m === 'DELETE') {
    return ok({ removed: await deleteKiosk(kioskMatch[1]) });
  }

  return notFound();
}
