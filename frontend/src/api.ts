// Thin API client. Authenticated calls attach the Cognito ID token; kiosk calls
// attach the device token headers.
import { fetchAuthSession } from 'aws-amplify/auth';
import { config } from './config';

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function req<T>(path: string, init: RequestInit = {}, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders,
      ...(init.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ── Authenticated (player / admin) ──
export const api = {
  async me() {
    return req<any>('/api/me', { headers: await authHeaders() });
  },
  async myBalance() {
    return req<any>('/api/me/balance', { headers: await authHeaders() });
  },
  async setPin(pin: string) {
    return req('/api/me/pin', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ pin }),
    });
  },
  // admin
  async adminPlayers() {
    return req<any>('/api/admin/players', { headers: await authHeaders() });
  },
  async createPlayer(p: { name: string; email?: string; phone?: string; pin?: string }) {
    return req('/api/admin/players', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(p),
    });
  },
  async charge(playerId: string, amountCents: number, note?: string) {
    return req(`/api/admin/players/${playerId}/charge`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ amountCents, note }),
    });
  },
  async credit(playerId: string, amountCents: number) {
    return req(`/api/admin/players/${playerId}/credit`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ amountCents }),
    });
  },
  async pending() {
    return req<any>('/api/admin/pending', { headers: await authHeaders() });
  },
  async admins() {
    return req<any>('/api/admin/admins', { headers: await authHeaders() });
  },
  async createAdmin(a: { name: string; email: string }) {
    return req('/api/admin/admins', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(a),
    });
  },
  async setAdminEmail(adminId: string, email: string) {
    return req(`/api/admin/admins/${adminId}/email`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify({ email }),
    });
  },
  async settlePayment(paymentId: string, action: 'confirm' | 'deny') {
    return req<{ result: string }>(`/api/admin/payments/${paymentId}/${action}`, {
      method: 'POST',
      headers: await authHeaders(),
    });
  },
  async kiosks() {
    return req<{ kiosks: Array<{ deviceId: string; label: string; active: boolean; lastSeenAt?: string }> }>(
      '/api/admin/kiosks',
      { headers: await authHeaders() },
    );
  },
  async createKiosk(deviceId: string, label?: string) {
    return req<{ deviceId: string; label: string; token: string }>('/api/admin/kiosks', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ deviceId, label }),
    });
  },
  // sessions
  async sessions() {
    return req<{ sessions: AdminSession[] }>('/api/admin/sessions', { headers: await authHeaders() });
  },
  async openSession() {
    return req<{ session: Session }>('/api/admin/sessions', { method: 'POST', headers: await authHeaders() });
  },
  async closeSession(sessionId: string) {
    return req<{ result: string }>(`/api/admin/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: await authHeaders(),
    });
  },
  async sessionDetail(sessionId: string) {
    return req<{ session: AdminSession; attendees: Attendee[] }>(`/api/admin/sessions/${sessionId}`, {
      headers: await authHeaders(),
    });
  },
  // player
  async mySession() {
    return req<MySession>('/api/me/session', { headers: await authHeaders() });
  },
  async myCheckin() {
    return req<CheckinResult>('/api/me/checkin', { method: 'POST', headers: await authHeaders() });
  },
  async myPayCard(plan?: Plan) {
    return req<{ paymentId: string; checkoutUrl: string }>('/api/me/pay-card', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(plan ? { plan } : {}),
    });
  },
  async grantPass(playerId: string, plan: Plan) {
    return req<{ pass: PassView; refundedCents: number }>(`/api/admin/players/${playerId}/pass`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ plan }),
    });
  },
};

export interface Session {
  sessionId: string;
  eventDate: string;
  openedAt: string;
  closesAt: string;
  closedAt?: string;
  openedByName: string;
  attendeeCount: number;
}
export interface AdminSession extends Session {
  open: boolean;
  endedAt: string | null;
  autoClosed?: boolean;
}
export interface Attendee {
  playerId: string;
  name: string;
  at: string;
  feeCents: number;
  source: 'kiosk' | 'player';
  coveredBy?: Plan;
}
export type Plan = 'quarter' | 'year';
export interface PlanOffer {
  plan: Plan;
  priceCents: number;
  label: string; // "Q1 2026–27 (Apr 1 – Jun 30)" / "2026–27 season"
  end: string; // YYYY-MM-DD
  /** not_offered: the year pass outside Q1 (Apr 1 – Jun 30). */
  status: 'available' | 'owned' | 'not_offered';
  available: boolean;
}
export interface PassView {
  plan: Plan;
  label: string;
  start: string;
  end: string;
}
export interface PayOptions {
  cardCents: number;
  cashCents: number;
  cardEnabled: boolean;
  plans: PlanOffer[];
}
export interface MySession {
  session: Session | null;
  checkedIn: boolean;
  balanceCents: number;
  feeCents: number;
  limitCents: number;
  pass: PassView | null;
  canCheckIn: boolean;
  needCents: number;
  options: PayOptions;
}

// ── Kiosk (device token) ──
function kioskHeaders(): Record<string, string> {
  return {
    'x-kiosk-device': localStorage.getItem('kioskDevice') ?? '',
    'x-kiosk-token': localStorage.getItem('kioskToken') ?? '',
  };
}

export const kiosk = {
  async players() {
    return req<{ players: Array<{ playerId: string; name: string; negative: boolean }> }>(
      '/api/kiosk/players',
      {},
      kioskHeaders(),
    );
  },
  async session() {
    return req<{
      session: Session | null;
      attendees: Array<{ playerId: string; name: string; at: string; negative: boolean }>;
    }>('/api/kiosk/session', {}, kioskHeaders());
  },
  async admins() {
    return req<{ admins: Array<{ adminId: string; name: string }> }>(
      '/api/kiosk/admins',
      {},
      kioskHeaders(),
    );
  },
  async checkin(playerId: string, pin: string) {
    return req<CheckinResult>(
      '/api/kiosk/checkin',
      { method: 'POST', body: JSON.stringify({ playerId, pin }) },
      kioskHeaders(),
    );
  },
  async payCard(playerId: string, pin: string, plan?: Plan) {
    return req<{ paymentId: string; amountCents: number; checkoutUrl: string }>(
      '/api/kiosk/pay',
      { method: 'POST', body: JSON.stringify({ playerId, pin, method: 'card', plan }) },
      kioskHeaders(),
    );
  },
  async payCash(playerId: string, pin: string, adminId: string, plan?: Plan) {
    return req<{ paymentId: string; amountCents: number; adminName: string; emailed: boolean }>(
      '/api/kiosk/pay',
      { method: 'POST', body: JSON.stringify({ playerId, pin, method: 'cash', adminId, plan }) },
      kioskHeaders(),
    );
  },
  async paymentStatus(paymentId: string) {
    return req<{
      status: string;
      amountCents: number;
      balanceCents: number;
      plan: Plan | null;
      periodLabel: string | null;
    }>(
      `/api/kiosk/payments/${paymentId}`,
      {},
      kioskHeaders(),
    );
  },
};

/**
 * checked_in / already: in the session. limit: balance too low, pay first
 * (needCents = how much brings them back within the limit). no_session: gym closed.
 */
export interface CheckinResult {
  result: 'checked_in' | 'already' | 'limit' | 'no_session';
  name: string;
  feeCents?: number;
  balanceCents?: number;
  owes?: number;
  needCents?: number;
  limitCents?: number;
  pass?: PassView | null;
  options?: PayOptions;
}

// ── Stripe return page (public; the server re-verifies with Stripe) ──
export const stripeReturn = (sessionId: string) =>
  req<{ status: string; amountCents: number }>(
    `/api/stripe/return?session_id=${encodeURIComponent(sessionId)}`,
  );

// ── Public confirm (magic link) ──
export const confirm = {
  async get(token: string) {
    return req<any>(`/api/confirm/${encodeURIComponent(token)}`);
  },
  async act(token: string, action: 'confirm' | 'deny') {
    return req<any>(`/api/confirm/${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
  },
};
