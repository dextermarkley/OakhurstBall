// A member on their phone: one-time contact step for an older account, the
// account page (balance, history with paging), editing contact + PIN, Pay now
// with cash, and the pending payment an admin later confirms.
import { test, expect } from '@playwright/test';
import { cleanup, getPlayer, makeCashier, makeUser, payments, seedHistory, signIn, watch } from '../lib/fx';

test.afterAll(cleanup);

test('older account without contact details is asked once, then not again', async ({ page }) => {
  const w = watch(page);
  const u = await makeUser({ label: 'nocontact', contact: false });
  await signIn(page, u);
  await expect(page.getByText('Your contact details')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Enter your phone number, like (415) 555-0123')).toBeVisible();
  await page.getByLabel('Your phone number').fill('+1 (415) 555-0177');
  await page.getByLabel('Emergency contact’s name').fill('ZZ E2E Partner');
  await page.getByLabel('Emergency contact’s phone number').fill('510-555-0188');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: /^Hi, ZZ/ })).toBeVisible({ timeout: 30000 });
  const p = await getPlayer(u.playerId);
  expect([p?.phone, p?.emergencyName, p?.emergencyPhone]).toEqual(['+14155550177', 'ZZ E2E Partner', '+15105550188']);
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Hi, ZZ/ })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Your contact details')).toHaveCount(0);
  w.assertClean();
});

test('account page: totals, history paging, contact + PIN edits', async ({ page }) => {
  const w = watch(page);
  const u = await makeUser({ label: 'regular', balanceCents: 1500 });
  await seedHistory(u.playerId, 30);
  await signIn(page, u);
  await expect(page.getByRole('heading', { name: /^Hi, ZZ/ })).toBeVisible({ timeout: 30000 });

  await expect(page.getByText('$15.00 credit').first()).toBeVisible();
  const checkins = page.locator('[data-slot=card]', { hasText: 'Check-ins' }).first();
  await expect(checkins).toContainText('30'); // all-time count, not one page

  const hist = page.locator('[data-slot=card]', { hasText: 'History' });
  await expect(hist.locator('tbody tr')).toHaveCount(25);
  await hist.getByRole('button', { name: 'Show older' }).click();
  await expect(hist.locator('tbody tr')).toHaveCount(30);
  await expect(hist.getByRole('button', { name: 'Show older' })).toHaveCount(0);
  await hist.getByRole('tab', { name: 'Payments' }).click();
  await expect(hist.locator('tbody tr')).toHaveCount(25);
  await hist.getByRole('button', { name: 'Show older' }).click();
  await expect(hist.locator('tbody tr')).toHaveCount(30);

  // Contact details: bad number refused, good one saved.
  const contact = page.locator('[data-slot=card]', { hasText: 'Contact details' });
  await contact.getByLabel('Their phone').fill('12');
  await contact.getByRole('button', { name: 'Save' }).click();
  await expect(contact.getByText('Enter their phone number, like (415) 555-0123')).toBeVisible();
  await contact.getByLabel('Their phone').fill('(650) 555-0142');
  await contact.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Contact details saved.')).toBeVisible();
  expect((await getPlayer(u.playerId))?.emergencyPhone).toBe('+16505550142');

  // Kiosk PIN.
  const pin = page.locator('[data-slot=card]', { hasText: 'Kiosk PIN' });
  await pin.getByLabel('New PIN').fill('12');
  await pin.getByRole('button', { name: 'Save PIN' }).click();
  await expect(pin.getByText('Use 4 to 6 digits')).toBeVisible();
  await pin.getByLabel('New PIN').fill('482913');
  await pin.getByRole('button', { name: 'Save PIN' }).click();
  await expect(page.getByText('PIN saved. Use it at the entrance kiosk.')).toBeVisible();
  expect((await getPlayer(u.playerId))?.pinHash).toBeTruthy();
  w.assertClean();
});

test('Pay now with cash: pick an amount and an admin, payment waits for them', async ({ page }) => {
  const w = watch(page);
  const u = await makeUser({ label: 'cashpay' });
  const cashier = await makeCashier();
  await signIn(page, u);
  await expect(page.getByRole('heading', { name: /^Hi, ZZ/ })).toBeVisible({ timeout: 30000 });

  await page.getByRole('button', { name: 'Pay now' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Add credit')).toBeVisible();
  await expect(dialog.getByText(/Quarter pass/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cash', exact: true }).first().click();
  await dialog.getByRole('button', { name: '$20.00' }).click();
  await expect(dialog.getByRole('heading', { name: 'Who are you giving $20.00 to?' })).toBeVisible();
  await dialog.getByRole('button', { name: cashier.name }).click();
  await expect(dialog.getByText(`Hand $20.00 to ${cashier.name}`)).toBeVisible();
  await expect(dialog.getByText(`${cashier.name} can confirm it on the Admin page.`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const pay = (await payments(u.playerId)).find((p) => p.status === 'pending');
  expect(pay?.amountCents).toBe(2000);
  expect(pay?.adminId).toBe(cashier.adminId);
  expect((await getPlayer(u.playerId))?.balanceCents, 'not credited until confirmed').toBe(0);

  const hist = page.locator('[data-slot=card]', { hasText: 'History' });
  await page.reload();
  await hist.getByRole('tab', { name: 'Payments' }).click();
  await expect(hist.locator('tbody tr').first()).toContainText(/pending/i);
  w.assertClean();
});
