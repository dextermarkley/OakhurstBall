// Input hygiene for text that people choose and other people see (names, labels).
// Pure functions, no AWS imports, so unit tests can load this file directly.

// C0/C1 controls, zero-width and bidi-override characters, line/paragraph separators.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;

export const MAX_NAME = 60;

/**
 * A display name safe to show anywhere: NFKC-normalized, no control, zero-width
 * or bidi-override characters, single spaces, at most `max` characters.
 * Returns '' when nothing printable is left.
 */
export function cleanName(v: unknown, max = MAX_NAME): string {
  if (typeof v !== 'string') return '';
  const s = v.normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}

/** One line for an email subject or a notification title: no CR/LF, capped. */
export function oneLine(v: string, max = 120): string {
  return [...v.replace(/[\r\n\u2028\u2029]+/g, ' ')].slice(0, max).join('');
}

export const EMAIL_MAX = 254;
// Unambiguous: the domain labels can't contain '.', so no catastrophic backtracking.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Lower-cased email, or null if it isn't a plausible address. */
export function cleanEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (!e || e.length > EMAIL_MAX || !EMAIL_RE.test(e)) return null;
  return e;
}

/** 24-hex ids (players, admins, payments, sessions). */
export const isId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);

/** Kiosk PINs: 4–6 digits. */
export const isPin = (v: unknown): v is string | number => /^\d{4,6}$/.test(typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '');
