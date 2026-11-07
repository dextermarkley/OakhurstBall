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
  listPlayers,
  listAdmins,
  getAdmin,
  createPlayer,
  createAdmin,
  adjustBalance,
  setPlayerPin,
  playerCheckins,
  playerPayments,
  createKiosk,
  listKiosks,
  listAdminsDetailed,
  setAdminEmail,
} from '../lib/repo.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import { ddb, TABLE, keys } from '../lib/ddb.js';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { verifySecret, hashSecret } from '../lib/crypto.js';
import {
  AMOUNTS,
  createCashPayment,
  createCardPayment,
  syncCardPayment,
  getPayment,
  listPending,
  adminSettle,
} from '../lib/payments.js';
import {
  StripeNotConfigured,
  stripeEnabled,
  webhookSecret,
  retrieveCheckoutSession,
  verifyWebhookSignature,
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
  type CheckInResult,
} from '../lib/sessions.js';
import { isPlan, type Plan } from '../lib/plans.js';
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
  if (offer.status === 'owned') return `Already covered for ${offer.label}`;
  if (offer.status === 'not_offered' && !asAdmin) {
    return 'The year pass is only sold Apr 1 – Jun 30. Buy a quarter pass instead.';
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
  return ok({ ...base, feeCents: r.feeCents });
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
    if (path.startsWith('/api/')) return await apiRouter(event, path, m);
    return notFound();
  } catch (err) {
    if (err instanceof StripeNotConfigured) return json(503, { error: err.message });
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
      return notFound('payment'); // unknown or malformed session id
    }
    const paymentId = s.metadata?.paymentId;
    if (!paymentId) return notFound('payment');
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
      if (paymentId) await syncCardPayment(paymentId);
    }
    return ok({ received: true });
  }

  return notFound();
}

// ─────────────────────────── Kiosk routes ───────────────────────────────────
// Guarded by the x-kiosk-token header validated against a KIOSK# record.
async function kioskRouter(
  event: APIGatewayProxyEventV2,
  path: string,
  m: string,
): Promise<APIGatewayProxyResultV2> {
  const token = event.headers?.['x-kiosk-token'] ?? event.headers?.['X-Kiosk-Token'];
  const deviceId = event.headers?.['x-kiosk-device'] ?? event.headers?.['X-Kiosk-Device'];
  if (!token || !deviceId) return unauthorized('missing kiosk credentials');

  const dev = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: keys.kioskProfile(deviceId) }),
  );
  if (!dev.Item || !(dev.Item as any).active) return unauthorized('unknown kiosk');
  if (!verifySecret(token, (dev.Item as any).deviceSecretHash)) {
    return unauthorized('bad kiosk token');
  }

  // GET /kiosk/players — picker list. Only a negative-balance flag, no amounts.
  if (path === '/kiosk/players' && m === 'GET') {
    const players = await listPlayers();
    return ok({
      players: players.map((p) => ({ playerId: p.playerId, name: p.name, negative: p.balanceCents < 0 })),
    });
  }

  // GET /kiosk/session — the open session (or null) and who is checked in.
  if (path === '/kiosk/session' && m === 'GET') {
    const session = await currentSession();
    if (!session) return ok({ session: null, attendees: [] });
    const [attendees, players] = await Promise.all([
      sessionAttendees(session.sessionId),
      listPlayers(),
    ]);
    const negative = new Map(players.map((p) => [p.playerId, p.balanceCents < 0]));
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
    const { playerId, pin } = parseBody(event);
    if (!playerId || !pin) return badRequest('playerId and pin required');
    const player = await getPlayer(playerId);
    if (!player) return notFound('player');
    if (!player.pinHash || !verifySecret(String(pin), player.pinHash)) {
      return unauthorized('wrong PIN');
    }
    const { mode } = parseBody(event);
    const r = await sessionCheckIn(player, AMOUNTS.dailyFee, 'kiosk', mode === 'defer' ? 'defer' : 'auto');
    return checkInResponse(player.name, r);
  }

  // POST /kiosk/pay  { playerId, pin, method: 'card' | 'cash', adminId?, plan? }
  // plan 'quarter' | 'year' buys a pass; no plan buys drop-in credit.
  // Amounts are fixed server-side; the kiosk never sends one.
  if (path === '/kiosk/pay' && m === 'POST') {
    const { playerId, pin, method: pm, adminId, plan: rawPlan } = parseBody(event);
    if (!playerId || !pin) return badRequest('playerId and pin required');
    if (pm !== 'card' && pm !== 'cash') return badRequest("method must be 'card' or 'cash'");
    if (rawPlan != null && !isPlan(rawPlan)) return badRequest("plan must be 'quarter' or 'year'");
    const plan = (rawPlan ?? undefined) as Plan | undefined;
    const player = await getPlayer(playerId);
    if (!player) return notFound('player');
    if (!player.pinHash || !verifySecret(String(pin), player.pinHash)) {
      return unauthorized('wrong PIN');
    }
    if (plan) {
      const blocked = await planBlocked(playerId, plan);
      if (blocked) return json(409, { error: blocked });
    }

    if (pm === 'card') {
      const { payment, checkoutUrl } = await createCardPayment({ playerId, playerName: player.name, plan });
      return created({ paymentId: payment.paymentId, amountCents: payment.amountCents, checkoutUrl });
    }

    if (!adminId) return badRequest('adminId required for cash');
    const admin = await getAdmin(adminId);
    if (!admin || !admin.active) return notFound('admin');
    const { payment, emailed } = await createCashPayment({
      playerId,
      playerName: player.name,
      adminId,
      adminEmail: admin.email,
      plan,
    });
    return created({
      paymentId: payment.paymentId,
      amountCents: payment.amountCents,
      adminName: admin.name,
      emailed,
    });
  }

  // GET /kiosk/payments/{paymentId} — the kiosk polls this while showing the QR.
  const payMatch = path.match(/^\/kiosk\/payments\/([a-f0-9]{24})$/);
  if (payMatch && m === 'GET') {
    const found = await getPayment(payMatch[1]);
    if (!found) return notFound('payment');
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

// ──────────────────────── Authenticated routes ──────────────────────────────
async function apiRouter(
  event: APIGatewayProxyEventV2,
  path: string,
  m: string,
): Promise<APIGatewayProxyResultV2> {
  const claims = getClaims(event);
  if (!claims) return unauthorized();
  const admin = isAdmin(claims);

  // GET /api/me — profile + role (+ linked player)
  if (path === '/api/me' && m === 'GET') {
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
    if (!player) return notFound('no linked player profile');
    const [checkins, payments, passes] = await Promise.all([
      playerCheckins(player.playerId),
      playerPayments(player.playerId),
      playerPasses(player.playerId),
    ]);
    return ok({
      playerId: player.playerId,
      name: player.name,
      balanceCents: player.balanceCents,
      owes: player.balanceCents < 0 ? -player.balanceCents : 0,
      checkins,
      payments,
      passes: passes.map(passView),
    });
  }

  // GET /api/me/session — the open session and this player's status in it
  if (path === '/api/me/session' && m === 'GET') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound('no linked player profile');
    const session = await currentSession();
    const [checkedIn, pass] = await Promise.all([
      session ? isCheckedIn(session.sessionId, player.playerId) : Promise.resolve(false),
      coveringPass(player.playerId, session?.eventDate),
    ]);
    const feeCents = pass ? 0 : AMOUNTS.dailyFee;
    const minBalance = feeCents - NEGATIVE_LIMIT_CENTS;
    // covered: pass · credit: balance pays the fee · owe: may pay next time · blocked: must pay first
    const payState = pass
      ? 'covered'
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
      canCheckIn: !!session && !checkedIn && (!!pass || player.balanceCents >= minBalance),
      needCents: pass ? 0 : Math.max(0, minBalance - player.balanceCents),
      options: await payOptions(pass),
    });
  }

  // POST /api/me/checkin — check in to the open session from the player page
  if (path === '/api/me/checkin' && m === 'POST') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound('no linked player profile');
    const { mode } = parseBody(event);
    const r = await sessionCheckIn(player, AMOUNTS.dailyFee, 'player', mode === 'defer' ? 'defer' : 'auto');
    return checkInResponse(player.name, r);
  }

  // POST /api/me/pay-card { plan? } — Stripe Checkout from the player page:
  // no plan = $20 credit, 'quarter' / 'year' = pass for the current period.
  if (path === '/api/me/pay-card' && m === 'POST') {
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound('no linked player profile');
    const { plan: rawPlan } = parseBody(event);
    if (rawPlan != null && !isPlan(rawPlan)) return badRequest("plan must be 'quarter' or 'year'");
    const plan = (rawPlan ?? undefined) as Plan | undefined;
    if (plan) {
      const blocked = await planBlocked(player.playerId, plan);
      if (blocked) return json(409, { error: blocked });
    }
    const { payment, checkoutUrl } = await createCardPayment({
      playerId: player.playerId,
      playerName: player.name,
      plan,
    });
    return created({ paymentId: payment.paymentId, amountCents: payment.amountCents, checkoutUrl });
  }

  // POST /api/me/pin  { pin }  — player sets their own kiosk PIN
  if (path === '/api/me/pin' && m === 'POST') {
    const { pin } = parseBody(event);
    if (!/^\d{4,6}$/.test(String(pin ?? ''))) return badRequest('pin must be 4-6 digits');
    const player = await getPlayerByCognitoSub(claims.sub);
    if (!player) return notFound('no linked player profile');
    await setPlayerPin(player.playerId, hashSecret(String(pin)));
    return ok({ updated: true });
  }

  // ── Admin-only below ──
  if (!admin) return forbidden('admin only');

  // GET /api/admin/players — with each player's pass for the current period
  if (path === '/api/admin/players' && m === 'GET') {
    const [players, holders] = await Promise.all([listPlayers(), currentPassHolders()]);
    return ok({
      players: players.map((p) => ({ ...p, pass: passView(holders.get(p.playerId) ?? null) })),
      plans: purchasable(null),
    });
  }

  // POST /api/admin/players/{id}/pass { plan } — record a pass paid outside the app
  const passMatch = path.match(/^\/api\/admin\/players\/([a-f0-9]{24})\/pass$/);
  if (passMatch && m === 'POST') {
    const { plan } = parseBody(event);
    if (!isPlan(plan)) return badRequest("plan must be 'quarter' or 'year'");
    if (!(await getPlayer(passMatch[1]))) return notFound('player');
    const blocked = await planBlocked(passMatch[1], plan, true);
    if (blocked) return json(409, { error: blocked });
    const p = await grantPass(passMatch[1], plan, claims.name || claims.email || 'Admin');
    if (!p) return json(409, { error: 'Pass already recorded' });
    const refundedCents = await refundCurrentSessionFee(passMatch[1], p);
    return created({ pass: passView(p), refundedCents });
  }

  // POST /api/admin/players  { name, email?, phone?, pin? }
  if (path === '/api/admin/players' && m === 'POST') {
    const { name, email, phone, pin } = parseBody(event);
    if (!name) return badRequest('name required');
    const player = await createPlayer({
      name,
      email,
      phone,
      pinHash: pin ? hashSecret(String(pin)) : undefined,
    });
    return created({ player: { playerId: player.playerId, name: player.name } });
  }

  // POST /api/admin/players/{id}/charge  { amountCents, note? }
  const chargeMatch = path.match(/^\/api\/admin\/players\/([^/]+)\/charge$/);
  if (chargeMatch && m === 'POST') {
    const { amountCents, note } = parseBody(event);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return badRequest('amountCents positive integer');
    }
    const balance = await adjustBalance(chargeMatch[1], -amountCents);
    return ok({ playerId: chargeMatch[1], balanceCents: balance, note });
  }

  // POST /api/admin/players/{id}/credit  { amountCents, note? }  (manual adj.)
  const creditMatch = path.match(/^\/api\/admin\/players\/([^/]+)\/credit$/);
  if (creditMatch && m === 'POST') {
    const { amountCents } = parseBody(event);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return badRequest('amountCents positive integer');
    }
    const balance = await adjustBalance(creditMatch[1], amountCents);
    return ok({ playerId: creditMatch[1], balanceCents: balance });
  }

  // GET /api/admin/pending — payments awaiting confirmation, with names
  if (path === '/api/admin/pending' && m === 'GET') {
    const pending = await listPending();
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
    });
  }

  // POST /api/admin/payments/{id}/confirm | /deny — cash only
  const settleMatch = path.match(/^\/api\/admin\/payments\/([a-f0-9]{24})\/(confirm|deny)$/);
  if (settleMatch && m === 'POST') {
    const r = await adminSettle(settleMatch[1], settleMatch[2] === 'confirm' ? 'confirmed' : 'denied');
    if (r === 'notfound') return notFound('payment');
    if (r === 'notcash') return badRequest('card payments are settled by Stripe');
    return ok({ result: r === 'already' ? 'already_handled' : settleMatch[2] === 'confirm' ? 'confirmed' : 'denied' });
  }

  // GET /api/admin/sessions — every session, newest first
  if (path === '/api/admin/sessions' && m === 'GET') {
    const now = new Date().toISOString();
    const sessions = await listSessions();
    return ok({
      sessions: sessions.map((s) => ({
        ...s,
        open: isOpen(s, now),
        endedAt: endedAt(s, now),
        autoClosed: !s.closedAt && s.closesAt <= now,
      })),
    });
  }

  // POST /api/admin/sessions — open the gym (409 if a session is already open)
  if (path === '/api/admin/sessions' && m === 'POST') {
    const s = await openSession(claims.name || claims.email || 'Admin');
    if (!s) return json(409, { error: 'A session is already open' });
    return created({ session: s });
  }

  // GET /api/admin/sessions/{id} — one session with its attendees
  const sessMatch = path.match(/^\/api\/admin\/sessions\/([a-f0-9]{24})$/);
  if (sessMatch && m === 'GET') {
    const s = await getSession(sessMatch[1]);
    if (!s) return notFound('session');
    const now = new Date().toISOString();
    return ok({
      session: { ...s, open: isOpen(s, now), endedAt: endedAt(s, now) },
      attendees: await sessionAttendees(s.sessionId),
    });
  }

  // POST /api/admin/sessions/{id}/close
  const closeMatch = path.match(/^\/api\/admin\/sessions\/([a-f0-9]{24})\/close$/);
  if (closeMatch && m === 'POST') {
    const r = await closeSession(closeMatch[1]);
    if (r === 'notfound') return notFound('session');
    return ok({ result: r });
  }

  // GET /api/admin/admins
  if (path === '/api/admin/admins' && m === 'GET') {
    return ok({ admins: await listAdminsDetailed() });
  }

  // POST /api/admin/admins  { name, email }
  if (path === '/api/admin/admins' && m === 'POST') {
    const { name, email } = parseBody(event);
    if (!name || !email) return badRequest('name and email required');
    if (!EMAIL_RE.test(String(email))) return badRequest('email looks invalid');
    const a = await createAdmin({ name: String(name), email: String(email).trim().toLowerCase() });
    return created({ admin: { adminId: a.adminId, name: a.name, email: a.email } });
  }

  // PUT /api/admin/admins/{id}/email  { email }
  const emailMatch = path.match(/^\/api\/admin\/admins\/([a-f0-9]{24})\/email$/);
  if (emailMatch && m === 'PUT') {
    const { email } = parseBody(event);
    if (!EMAIL_RE.test(String(email ?? ''))) return badRequest('email looks invalid');
    try {
      await setAdminEmail(emailMatch[1], String(email).trim().toLowerCase());
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') return notFound('admin');
      throw err;
    }
    return ok({ updated: true });
  }

  // GET /api/admin/kiosks — provisioned iPad devices (no secrets)
  if (path === '/api/admin/kiosks' && m === 'GET') {
    return ok({ kiosks: await listKiosks() });
  }

  // POST /api/admin/kiosks  { deviceId, label? }
  // Returns the one-time token to paste into the iPad's /kiosk pairing screen.
  // Re-posting the same deviceId rotates (regenerates) its token.
  if (path === '/api/admin/kiosks' && m === 'POST') {
    const { deviceId, label } = parseBody(event);
    if (!deviceId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(String(deviceId))) {
      return badRequest('deviceId: letters, digits, _ or - (2-64 chars), e.g. court-ipad-1');
    }
    const result = await createKiosk(String(deviceId), String(label ?? ''));
    return created(result); // { deviceId, label, token } — token shown once
  }

  return notFound();
}
