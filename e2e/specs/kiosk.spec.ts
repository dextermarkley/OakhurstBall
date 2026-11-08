// Game night: an admin opens the gym, players check in on the entrance kiosk
// (wrong PIN, credit pays the fee, cash for someone with no credit that an admin
// confirms), and the admin closes the gym. Uses alpha's one current session, so
// it skips if a session is already open there.
import { test, expect } from '@playwright/test';
import { cleanup, currentSession, getPlayer, makeCashier, makeKiosk, makeKioskPlayer, makeUser, pairKiosk, signIn, track, until, watch } from '../lib/fx';

test.afterAll(async () => {
  // A session this spec opened but didn't close (a step failed): close it.
  const s = await currentSession();
  if (s && openedHere && s.sessionId === openedHere) {
    track.key({ PK: 'CURRENT', SK: 'SESSION' });
  }
  if (openedHere) track.partition(`SESSION#${openedHere}`);
  await cleanup();
});
let openedHere: string | undefined;

test('open the gym, check in on the kiosk, pay cash, close the gym', async ({ browser }) => {
  const s = await currentSession();
  test.skip(!!s && s.closesAt > new Date().toISOString(), 'a session is already open on alpha');

  const admin = await makeUser({ label: 'gymadmin', admin: true });
  const cashier = await makeCashier('Door');
  const rich = await makeKioskPlayer('Credit', 2000, '1357');
  const broke = await makeKioskPlayer('Broke', -1000, '2468'); // at the limit: must pay first
  const kiosk = await makeKiosk();

  const adminCtx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const kioskCtx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1180, height: 820 } }); // iPad landscape
  const a = await adminCtx.newPage();
  const k = await kioskCtx.newPage();
  const wa = watch(a);
  const wk = watch(k);

  // Before opening, the kiosk says the gym is closed.
  await pairKiosk(k, kiosk);
  await expect(k.getByText('The gym isn’t open right now')).toBeVisible({ timeout: 30000 });

  // Admin opens a session.
  await signIn(a, admin, '/admin?tab=sessions');
  await a.getByRole('button', { name: 'Open session' }).click();
  await expect(a.getByText('Session opened. Players can check in now.')).toBeVisible();
  openedHere = (await currentSession())?.sessionId;
  expect(openedHere).toBeTruthy();

  // Kiosk picks it up and lists players.
  await k.reload();
  await expect(k.getByText('Tap your name to check in')).toBeVisible({ timeout: 30000 });
  await k.getByLabel('Search players').fill(rich.name);
  await k.getByRole('button', { name: rich.name }).click();
  await expect(k.getByText('Enter your PIN, then tap ✓')).toBeVisible();

  // Wrong PIN.
  for (const d of '9999') await k.getByRole('button', { name: d, exact: true }).click();
  await k.getByLabel('Enter').click();
  await expect(k.getByText('Wrong PIN. Try again.')).toBeVisible();
  // Right PIN: $20 credit pays the $5 fee.
  for (const d of '1357') await k.getByRole('button', { name: d, exact: true }).click();
  await k.getByLabel('Enter').click();
  await expect(k.getByRole('button', { name: 'Done', exact: true })).toBeVisible({ timeout: 20000 });
  expect((await getPlayer(rich.playerId))?.balanceCents).toBe(1500);
  await k.getByRole('button', { name: 'Done', exact: true }).click();

  // They show as checked in, on the kiosk and on the admin's open session.
  await expect(k.getByRole('button', { name: new RegExp(rich.name) })).toContainText('Checked in');
  await a.reload();
  await expect(a.getByText(rich.name)).toBeVisible({ timeout: 30000 });

  // A player at the limit must pay; they hand $10 cash to the door admin.
  await k.getByLabel('Search players').fill(broke.name);
  await k.getByRole('button', { name: broke.name }).click();
  for (const d of '2468') await k.getByRole('button', { name: d, exact: true }).click();
  await k.getByLabel('Enter').click();
  await expect(k.getByText(/please pay to check in/)).toBeVisible({ timeout: 20000 });
  await k.getByRole('button', { name: /Cash/ }).first().click();
  await expect(k.getByRole('heading', { name: /Who are you giving/ })).toBeVisible();
  await k.getByRole('button', { name: '$5.00 more' }).click();
  await expect(k.getByRole('heading', { name: 'Who are you giving $10.00 to?' })).toBeVisible();
  await k.getByRole('button', { name: cashier.name }).click();
  await expect(k.getByText(`Hand $10.00 to ${cashier.name}`)).toBeVisible();

  // The admin confirms it on the Payments tab; the kiosk notices and checks them in.
  await a.goto('/admin?tab=payments');
  const row = a.locator('tr', { hasText: broke.name });
  await row.getByRole('button', { name: 'Confirm' }).click();
  await a.getByRole('alertdialog').getByRole('button', { name: 'Confirm payment' }).click();
  await expect(row).toHaveCount(0);
  await expect(k.getByRole('button', { name: 'Done', exact: true })).toBeVisible({ timeout: 30000 });
  // -$10 + $10 cash - $5 fee, once the kiosk has checked them in.
  await until(async () => (await getPlayer(broke.playerId))?.balanceCents === -500, 30000, 'cash credited and fee charged');

  // Admin closes the gym; the kiosk goes back to "closed".
  await a.goto('/admin?tab=sessions');
  await a.getByRole('button', { name: 'Close', exact: true }).click();
  await a.getByRole('alertdialog').getByRole('button', { name: 'Close session' }).click();
  await expect(a.getByText('The gym is closed').first()).toBeVisible();
  await k.reload();
  await expect(k.getByText('The gym isn’t open right now')).toBeVisible({ timeout: 30000 });

  wa.assertClean();
  wk.assertClean();
  await adminCtx.close();
  await kioskCtx.close();
});
