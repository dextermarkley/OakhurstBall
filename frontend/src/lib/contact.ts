// Phone + emergency contact, checked the same way as the server (backend/src/lib/contact.ts).
import { z } from 'zod';

/** A phone number as E.164, or null. US numbers any common way; others need +country. */
export function normalizePhone(v: string): string | null {
  const s = v.trim();
  if (s.length > 40 || !/^\+?[\d\s().-]+$/.test(s)) return null;
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return d.length >= 8 && d.length <= 15 && d[0] !== '0' ? `+${d}` : null;
  if (d.length === 10 && /^[2-9]/.test(d)) return `+1${d}`;
  if (d.length === 11 && d[0] === '1' && /^[2-9]/.test(d[1])) return `+${d}`;
  return null;
}

/** "+14155550123" → "(415) 555-0123"; other countries as stored. */
export function phoneText(e164?: string | null): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const phone = (msg: string) => z.string().trim().refine((v) => !!normalizePhone(v), msg);
export const contactShape = {
  phone: phone('Enter your phone number, like (415) 555-0123'),
  emergencyName: z.string().trim().min(2, 'Enter your emergency contact’s name').max(60),
  emergencyPhone: phone('Enter their phone number, like (415) 555-0123'),
};
export const contactSchema = z.object(contactShape).refine((v) => normalizePhone(v.phone) !== normalizePhone(v.emergencyPhone), {
  path: ['emergencyPhone'],
  message: 'Your emergency contact needs a different number from yours',
});
export type ContactValues = z.infer<typeof contactSchema>;

// Details typed at sign-up wait here until the new account first signs in
// (confirming the email can happen later). Keyed by email so they can only
// ever be saved to the account they were typed for.
const PENDING = 'pendingContact';
export const savePendingContact = (email: string, c: ContactValues) =>
  localStorage.setItem(PENDING, JSON.stringify({ email: email.trim().toLowerCase(), ...c }));
export function takePendingContact(email: string): ContactValues | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING) ?? 'null');
    if (!p || p.email !== email.trim().toLowerCase()) return null;
    return { phone: p.phone, emergencyName: p.emergencyName, emergencyPhone: p.emergencyPhone };
  } catch {
    return null;
  }
}
export const clearPendingContact = () => localStorage.removeItem(PENDING);
