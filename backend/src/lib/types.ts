// Shared domain types.

export type Role = 'admin' | 'player';

export type PaymentMethod = 'cash' | 'venmo' | 'card';
export type PaymentStatus = 'pending' | 'confirmed' | 'denied' | 'expired';

export interface Player {
  playerId: string;
  name: string;
  email?: string;
  phone?: string; // E.164
  /** Emergency contact (required for members with an account; see contact.ts). */
  emergencyName?: string;
  emergencyPhone?: string; // E.164
  /** bcrypt-style hash of the kiosk PIN (we use scrypt from node:crypto). */
  pinHash?: string;
  /** Balance in cents. Negative = the player owes the club money. */
  balanceCents: number;
  cognitoSub?: string;
  active: boolean;
  /** Approved by an admin for members-only features (the chat). */
  approved?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Admin {
  adminId: string;
  name: string;
  /** Login email; links this admin record to their account on first sign-in. */
  email?: string;
  phone?: string; // E.164; kept for a future SMS channel
  cognitoSub?: string;
  active: boolean;
  createdAt: string;
}

export interface CheckIn {
  playerId: string;
  eventDate: string; // YYYY-MM-DD
  at: string; // ISO
  source: 'kiosk' | 'admin';
}

export interface Payment {
  paymentId: string;
  playerId: string;
  amountCents: number;
  method: PaymentMethod;
  status: PaymentStatus;
  /** Admin who must confirm a cash payment. */
  adminId?: string;
  /**
   * Legacy only: older cash payments stored their confirm-link token here. It is
   * a capability (whoever holds it can confirm), so it is never sent to clients
   * and new payments don't store it. See paymentView().
   */
  confirmToken?: string;
  /** sha256 of the confirm-link token: finds its TOKENH# row, can't confirm anything. */
  confirmTokenHash?: string;
  /** Who settled it: 'link' (confirm link from a notification), 'admin:<sub>', 'stripe'. */
  settledBy?: string;
  /** Stripe reported a refund or a dispute on this card payment. */
  reversed?: 'refunded' | 'disputed';
  /** Stripe Checkout session for card payments. */
  stripeSessionId?: string;
  /** Set when the payment buys a quarter/year pass instead of balance credit. */
  plan?: 'quarter' | 'year';
  periodId?: string;
  periodLabel?: string;
  periodStart?: string;
  periodEnd?: string;
  /** The pass was already held, so the money went to the balance instead. */
  creditedInstead?: boolean;
  createdAt: string;
  settledAt?: string;
  note?: string;
}

export interface KioskDevice {
  deviceId: string;
  label: string;
  /** 'sha256:<hex>' (current) or scrypt 'salt:hash' (kiosks paired before the change). */
  deviceSecretHash: string;
  active: boolean;
  lastSeenAt?: string;
}

// Public DTOs (no hashes / tokens leak to clients).
export interface PublicPlayer {
  playerId: string;
  name: string;
  balanceCents: number;
  /** Signed waiver / acknowledged rules versions (see agreements.ts). */
  waiverVersion?: string;
  rulesVersion?: string;
  agreedAt?: string;
  approved?: boolean;
  email?: string;
  createdAt?: string;
  /** Signed up with an account (vs. added by an admin for the kiosk). */
  hasAccount?: boolean;
  phone?: string;
  emergencyName?: string;
  emergencyPhone?: string;
}
