// Card payment end to end, Stripe TEST mode: Pay now → Stripe Checkout (test card
// 4242…) → back to the app → $20 credited. Then the payment is refunded in
// Stripe, and the refund webhook takes the credit back.
import { test, expect, type Page } from '@playwright/test';
import { cleanup, getPlayer, makeUser, param, payments, signIn, until, watch } from '../lib/fx';

test.afterAll(cleanup);

async function stripe(path: string, body?: Record<string, string>) {
  const key = await param('/stripe/secret-key');
  if (!key.startsWith('sk_test_')) throw new Error('alpha must use a Stripe TEST key');
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`stripe ${path}: ${j?.error?.message}`);
  return j;
}

/** Fill Stripe's hosted Checkout page with the always-approved test card. */
async function payOnStripe(page: Page) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
  // Newer Checkout lists payment methods; pick Card if it's collapsed.
  const cardChoice = page.locator('[data-testid="card-accordion-item-button"], #payment-method-accordion-item-title-card');
  if (await cardChoice.first().isVisible({ timeout: 8000 }).catch(() => false)) await cardChoice.first().click();
  await page.locator('#cardNumber').fill('4242424242424242');
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  const name = page.locator('#billingName');
  if (await name.isVisible().catch(() => false)) await name.fill('ZZ E2E Card');
  const zip = page.locator('#billingPostalCode');
  if (await zip.isVisible().catch(() => false)) await zip.fill('94110');
  // "Save my info" (Link) would ask for a phone number: leave it off.
  const save = page.locator('#enableStripePass');
  if (await save.isChecked().catch(() => false)) await save.uncheck();
  await page.locator('[data-testid="hosted-payment-submit-button"], button.SubmitButton').first().click();
}

test('card payment through Stripe Checkout, then a refund takes it back', async ({ page }) => {
  const w = watch(page);
  const u = await makeUser({ label: 'card' });
  await signIn(page, u);
  await expect(page.getByRole('heading', { name: /^Hi, ZZ/ })).toBeVisible({ timeout: 30000 });

  await page.getByRole('button', { name: 'Pay now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Card · \$20\.00/ }).click();
  await payOnStripe(page);

  // Back on the app's "paid" page, which confirms with Stripe.
  await page.waitForURL(/oakhurst-ball\.org\/(paid|player)/, { timeout: 60000 });
  await until(async () => (await getPlayer(u.playerId))?.balanceCents === 2000, 60000, '$20 credited');
  const pay = (await payments(u.playerId)).find((p) => p.method === 'card');
  expect(pay?.status).toBe('confirmed');
  expect(pay?.settledBy).toBe('stripe');

  // The player sees it.
  await page.goto('/player');
  await expect(page.getByText('$20.00 credit').first()).toBeVisible({ timeout: 30000 });

  // Refund it in Stripe; the charge.refunded webhook reverses the credit.
  const session = await stripe(`/checkout/sessions/${pay!.stripeSessionId}`);
  await stripe('/refunds', { payment_intent: session.payment_intent });
  await until(async () => (await getPlayer(u.playerId))?.balanceCents === 0, 90000, 'refund webhook reversed the credit');
  const after = (await payments(u.playerId)).find((p) => p.paymentId === pay!.paymentId);
  expect(after?.reversed).toBe('refunded');
  w.problems.splice(0, w.problems.length, ...w.problems.filter((p) => !p.includes('stripe.com'))); // Stripe's own page noise
  w.assertClean();
});
