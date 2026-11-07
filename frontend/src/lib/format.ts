// Display formatting shared by every screen.

export const money = (cents: number) =>
  (Math.abs(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** "$12.00 credit", "−$5.00", "$0.00" */
export function balanceText(cents: number) {
  if (cents < 0) return `−${money(cents)}`;
  if (cents > 0) return `${money(cents)} credit`;
  return money(0);
}

export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

export const longDateOf = (iso: string) =>
  new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** A club-local YYYY-MM-DD shown as "Dec 31, 2026" (noon avoids TZ day shifts). */
export const ymdText = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export const planName = (plan: 'quarter' | 'year') => (plan === 'year' ? 'Year pass' : 'Quarter pass');
