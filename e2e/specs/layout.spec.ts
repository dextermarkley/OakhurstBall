// Every screen at phone, tablet and desktop widths: it loads without errors and
// nothing sticks out sideways (the bug the Pay now dialog had on desktop).
import { test, expect } from '@playwright/test';
import { cleanup, makeKiosk, makeUser, pairKiosk, seedHistory, signIn, watch, expectNoOverflow, type TestUser } from '../lib/fx';

let admin: TestUser;
let kiosk: { id: string; token: string };
test.beforeAll(async () => {
  admin = await makeUser({ label: 'layout', admin: true, balanceCents: 500 });
  await seedHistory(admin.playerId, 8);
  kiosk = await makeKiosk();
});
test.afterAll(cleanup);

const WIDTHS: Array<[string, number, number]> = [
  ['phone', 390, 844],
  ['tablet', 820, 1180],
  ['desktop', 1440, 900],
];

for (const [label, width, height] of WIDTHS) {
  test(`screens fit at ${label} width (${width}px)`, async ({ browser }) => {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height } });
    const page = await ctx.newPage();
    const w = watch(page);

    await page.goto('/');
    await expectNoOverflow(page);

    await signIn(page, admin);
    await expect(page.getByRole('heading', { name: /^Hi, ZZ/ })).toBeVisible({ timeout: 30000 });
    await expectNoOverflow(page);
    await page.getByRole('button', { name: 'Pay now' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoOverflow(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Cash', exact: true }).first().click();
    await expectNoOverflow(page);
    await page.keyboard.press('Escape');

    await page.goto('/chat');
    await expect(page.getByText('Oakhurst chat')).toBeVisible({ timeout: 30000 });
    await expectNoOverflow(page);

    for (const tab of ['overview', 'sessions', 'players', 'payments', 'expenses', 'admins', 'kiosks']) {
      await page.goto(`/admin?tab=${tab}`);
      await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30000 });
      await page.waitForLoadState('networkidle');
      await expectNoOverflow(page);
    }

    await pairKiosk(page, kiosk);
    await expect(page.getByText(/The gym isn’t open right now|Tap your name to check in/)).toBeVisible({ timeout: 30000 });
    await expectNoOverflow(page);

    w.assertClean();
    await ctx.close();
  });
}
