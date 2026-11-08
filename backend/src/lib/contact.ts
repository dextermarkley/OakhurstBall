// A player's phone and emergency contact. Required for every member with an
// account (asked at sign-up, or once after sign-in for older accounts). Only the
// player and admins can see them. Pure: no AWS imports, so unit tests load it.
import { cleanName } from './text.js';

export interface Contact {
  /** E.164, e.g. +14155550123 */
  phone: string;
  emergencyName: string;
  emergencyPhone: string;
}

/**
 * A phone number as E.164, or null. US numbers may be typed any common way
 * ("(415) 555-0123", "415.555.0123", "1 415 555 0123"); other countries need
 * the leading "+" and country code.
 */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const s = v.trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 && digits[0] !== '0' ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1' && /^[2-9]/.test(digits[1])) return `+${digits}`;
  return null;
}

export function checkContact(b: any): { contact?: Contact; error?: string } {
  const phone = normalizePhone(b?.phone);
  if (!phone) return { error: 'Enter your phone number, like (415) 555-0123' };
  const emergencyName = cleanName(b?.emergencyName);
  if (emergencyName.length < 2) return { error: 'Enter your emergency contact’s name' };
  const emergencyPhone = normalizePhone(b?.emergencyPhone);
  if (!emergencyPhone) return { error: 'Enter your emergency contact’s phone number' };
  if (emergencyPhone === phone) return { error: 'Your emergency contact needs a different number from yours' };
  return { contact: { phone, emergencyName, emergencyPhone } };
}

/** True when the stored profile has all three. */
export const hasContact = (p: any) => !!(p?.phone && p?.emergencyName && p?.emergencyPhone);
