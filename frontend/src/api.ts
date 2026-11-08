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
  // announcement + RSVP
  async announcement() {
    return req<{ announcement: Announcement | null; defaultText: string; myPlayerId: string | null }>(
      '/api/announcement',
      { headers: await authHeaders() },
    );
  },
  async rsvp(announceId: string, status: RsvpStatus | null) {
    return req<{ announcement: Announcement | null }>('/api/announcement/rsvp', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ announceId, status }),
    });
  },
  async postAnnouncement(text: string) {
    return req<{ announcement: Announcement }>('/api/admin/announcement', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ text }),
    });
  },
  async editAnnouncement(announceId: string, text: string, notify: boolean) {
    return req<{ announcement: Announcement | null }>('/api/admin/announcement', {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify({ announceId, text, notify }),
    });
  },
  async removeAnnouncement(announceId: string) {
    return req<{ removed: boolean }>('/api/admin/announcement', {
      method: 'DELETE',
      headers: await authHeaders(),
      body: JSON.stringify({ announceId }),
    });
  },
  // chat
  async chat(q: { before?: string } = {}) {
    const qs = q.before ? `?before=${encodeURIComponent(q.before)}` : '';
    return req<{ messages: ChatMessage[]; hasMore: boolean; now: string; mySub: string }>(`/api/chat${qs}`, {
      headers: await authHeaders(),
    });
  },
  async chatPoll(after: string, since: string) {
    return req<{ messages: ChatMessage[]; deleted: string[]; now: string }>(
      `/api/chat?after=${encodeURIComponent(after)}&since=${encodeURIComponent(since)}`,
      { headers: await authHeaders() },
    );
  },
  async chatSend(m: { text?: string; imageKey?: string; width?: number; height?: number }) {
    return req<{ message: ChatMessage }>('/api/chat', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(m),
    });
  },
  async chatUpload(file: Blob) {
    const t = await req<{ key: string; url: string; fields: Record<string, string> }>('/api/chat/upload', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ contentType: file.type, size: file.size }),
    });
    const form = new FormData();
    for (const [k, v] of Object.entries(t.fields)) form.append(k, v);
    form.append('file', file);
    const r = await fetch(t.url, { method: 'POST', body: form });
    if (!r.ok) throw new Error(r.status === 400 ? 'That image is too big or not supported' : 'Upload failed');
    return t.key;
  },
  async chatLatest() {
    return req<{ cursor: string | null; mine: boolean }>('/api/chat/latest', { headers: await authHeaders() });
  },
  async chatDelete(cursor: string) {
    return req('/api/chat/delete', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ cursor }) });
  },
  async chatPrefs() {
    return req<{ chatNotify: boolean }>('/api/chat/prefs', { headers: await authHeaders() });
  },
  async setChatPrefs(chatNotify: boolean) {
    return req<{ chatNotify: boolean }>('/api/chat/prefs', {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify({ chatNotify }),
    });
  },
  // notifications (Web Push)
  async pushKey() {
    return req<{ publicKey: string }>('/api/me/push', { headers: await authHeaders() });
  },
  async pushSubscribe(subscription: PushSubscriptionJSON) {
    return req<{ subscribed: boolean }>('/api/me/push', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ subscription }),
    });
  },
  async pushUnsubscribe(endpoint: string) {
    return req<{ removed: boolean }>('/api/me/push', {
      method: 'DELETE',
      headers: await authHeaders(),
      body: JSON.stringify({ endpoint }),
    });
  },
  async pushTest() {
    return req<{ sent: number; failed: number }>('/api/me/push/test', { method: 'POST', headers: await authHeaders() });
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
  // waiver + club rules
  async agreements() {
    return req<AgreementsStatus>('/api/me/agreements', { headers: await authHeaders() });
  },
  async signAgreements(b: {
    waiverVersion: string;
    rulesVersion: string;
    agreeRules: boolean;
    agreeWaiver: boolean;
    signedName: string;
    adult: boolean;
    guardianName?: string;
  }) {
    return req<{ current: boolean; agreedAt: string }>('/api/me/agreements', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(b),
    });
  },
  // expenses
  async expenses(season?: number) {
    return req<ExpenseReport>(`/api/admin/expenses${season ? `?season=${season}` : ''}`, { headers: await authHeaders() });
  },
  async addExpense(e: ExpenseInput) {
    return req<{ expense: Expense }>('/api/admin/expenses', { method: 'POST', headers: await authHeaders(), body: JSON.stringify(e) });
  },
  async updateExpense(cursor: string, e: ExpenseInput) {
    return req<{ expense: Expense }>('/api/admin/expenses/update', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ cursor, ...e }),
    });
  },
  async deleteExpense(cursor: string) {
    return req('/api/admin/expenses/delete', { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ cursor }) });
  },
  async deleteKiosk(deviceId: string) {
    return req<{ removed: boolean }>(`/api/admin/kiosks/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
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
  async myCheckin(mode: CheckinMode = 'auto') {
    return req<CheckinResult>('/api/me/checkin', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ mode }),
    });
  },
  async myPayCard(plan?: Plan) {
    return req<{ paymentId: string; checkoutUrl: string }>('/api/me/pay-card', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(plan ? { plan } : {}),
    });
  },
  async myAdmins() {
    return req<{ admins: Array<{ adminId: string; name: string }> }>('/api/me/admins', { headers: await authHeaders() });
  },
  async myPayCash(adminId: string, plan?: Plan) {
    return req<{ paymentId: string; amountCents: number; adminName: string; emailed: boolean }>('/api/me/pay-cash', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ adminId, plan }),
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

export interface AgreementDoc {
  kind: 'waiver' | 'rules';
  version: string;
  title: string;
  intro: string;
  sections: Array<{ heading?: string; body: string }>;
}
export interface AgreementsStatus {
  waiver: AgreementDoc;
  rules: AgreementDoc;
  hasPlayer: boolean;
  current: boolean;
  signed: { waiverVersion: string; rulesVersion: string; agreedAt: string; signedName: string } | null;
}

export type ExpenseCategory = 'basketballs' | 'insurance' | 'facility' | 'other';
export interface ExpenseInput {
  date: string;
  category: ExpenseCategory;
  amountCents: number;
  note?: string;
}
export interface Expense extends ExpenseInput {
  expenseId: string;
  cursor: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}
export interface ExpenseReport {
  season: { year: number; label: string; start: string; end: string; current: boolean };
  seasons: Array<{ year: number; label: string }>;
  today: string;
  expenses: Expense[];
  totalCents: number;
  byCategory: Record<ExpenseCategory, number>;
  incomeCents: number;
  monthCents: number;
  facilityThisMonth: boolean | null;
  lastAmounts: Partial<Record<ExpenseCategory, number>>;
}

export type RsvpStatus = 'in' | 'out';
export interface Rsvp {
  playerId: string;
  name: string;
  status: RsvpStatus;
  at: string;
}
export interface Announcement {
  announceId: string;
  text: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  createdByName: string;
  rsvps: Rsvp[];
}
export interface ChatMessage {
  messageId: string;
  cursor: string;
  sub: string;
  name: string;
  text?: string;
  image?: { url: string; width?: number; height?: number };
  createdAt: string;
}

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
  /** covered: pass · credit: balance pays the fee · owe: may pay next time · blocked: must pay first */
  payState: 'covered' | 'credit' | 'owe' | 'blocked';
  needCents: number;
  options: PayOptions;
}

export type CheckinMode = 'auto' | 'defer';

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
  async checkin(playerId: string, pin: string, mode: CheckinMode = 'auto') {
    return req<CheckinResult>(
      '/api/kiosk/checkin',
      { method: 'POST', body: JSON.stringify({ playerId, pin, mode }) },
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
 * checked_in / already: in the session.
 * needs_payment: not checked in yet; credit doesn't cover the fee but they may
 *   pay next time (check in again with mode 'defer').
 * limit: would go past the negative limit; must pay first (needCents).
 * no_session: gym closed.
 */
export interface CheckinResult {
  result: 'checked_in' | 'already' | 'needs_payment' | 'limit' | 'no_session';
  name: string;
  feeCents?: number;
  balanceCents?: number;
  balanceAfterCents?: number;
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
