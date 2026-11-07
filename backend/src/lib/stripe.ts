// Minimal Stripe client: REST over fetch (no SDK), keys from SSM Parameter Store.
//
// Keys live in SecureString parameters (free; Secrets Manager is $0.40/secret/mo):
//   /oakhurst/stripe/secret-key      sk_live_... or sk_test_...
//   /oakhurst/stripe/webhook-secret  whsec_...   (optional; see docs/payments.md)
// Missing keys are not cached, so setting them takes effect without a redeploy.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createHmac, timingSafeEqual } from 'node:crypto';

const ssm = new SSMClient({});
const SECRET_PARAM = process.env.STRIPE_SECRET_PARAM ?? '/oakhurst/stripe/secret-key';
const WEBHOOK_PARAM = process.env.STRIPE_WEBHOOK_PARAM ?? '/oakhurst/stripe/webhook-secret';

const cache = new Map<string, string>();

async function param(name: string): Promise<string | null> {
  const hit = cache.get(name);
  if (hit) return hit;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const v = r.Parameter?.Value?.trim();
    if (v) cache.set(name, v);
    return v || null;
  } catch (err: any) {
    if (err?.name === 'ParameterNotFound') return null;
    throw err;
  }
}

export class StripeNotConfigured extends Error {
  constructor() {
    super('Card payments are not set up yet');
  }
}

export const stripeEnabled = async () => !!(await param(SECRET_PARAM));
export const webhookSecret = () => param(WEBHOOK_PARAM);

async function stripe(method: 'GET' | 'POST', path: string, params?: Record<string, string>) {
  const key = await param(SECRET_PARAM);
  if (!key) throw new StripeNotConfigured();
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: method === 'POST' && params ? new URLSearchParams(params).toString() : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`stripe ${res.status}: ${json?.error?.message ?? 'error'}`);
  return json;
}

export interface CheckoutSession {
  id: string;
  url: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number;
  currency: string;
  metadata: Record<string, string>;
}

/**
 * Hosted Checkout page. Apple Pay / Google Pay appear automatically on supporting
 * devices (Stripe hosts the page, so no Apple domain verification is needed).
 */
export async function createCheckoutSession(input: {
  paymentId: string;
  playerId: string;
  playerName: string;
  amountCents: number;
  productName: string;
  productDescription: string;
  baseUrl: string;
}): Promise<CheckoutSession> {
  const expiresAt = Math.floor(Date.now() / 1000) + 35 * 60; // Stripe minimum is 30 min
  return stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    // Which payment methods appear (card, Apple/Google Pay, Klarna, bank…) is set in
    // the Stripe Dashboard → Settings → Payment methods. Stripe rejects
    // payment_method_types on Checkout Sessions now, so don't pass it here.
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(input.amountCents),
    'line_items[0][price_data][product_data][name]': input.productName,
    'line_items[0][price_data][product_data][description]': input.productDescription,
    success_url: `${input.baseUrl}/paid?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.baseUrl}/paid?cancelled=1`,
    client_reference_id: input.paymentId,
    'metadata[paymentId]': input.paymentId,
    'metadata[playerId]': input.playerId,
    'payment_intent_data[metadata][paymentId]': input.paymentId,
    expires_at: String(expiresAt),
  });
}

export async function retrieveCheckoutSession(id: string): Promise<CheckoutSession> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new Error('bad session id');
  return stripe('GET', `/checkout/sessions/${id}`);
}

/**
 * Verify a Stripe-Signature header ("t=...,v1=...") over the raw request body.
 * Rejects signatures older than 5 minutes (replay protection).
 */
export function verifyWebhookSignature(rawBody: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return header
    .split(',')
    .filter((kv) => kv.startsWith('v1='))
    .some((kv) => {
      const sig = Buffer.from(kv.slice(3), 'hex');
      return sig.length === expected.length && timingSafeEqual(sig, expected);
    });
}
