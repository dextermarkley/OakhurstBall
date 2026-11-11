// An organizer at a desktop: every Admin tab, confirming a player's cash,
// notices, the session announcement + RSVP, expenses, adding a player, pairing
// and removing a kiosk.
import { test, expect, type Page } from '@playwright/test';
import * as C from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ENV, cleanup, cog, currentAnnouncement, ddb, getPlayer, makeCashier, makeUser, run, signIn, track, until, watch, type TestUser,
} from '../lib/fx';

let admin: TestUser;
test.beforeAll(async () => {
  admin = await makeUser({ label: 'admin', admin: true });
});
test.afterAll(async () => {
  // Anything the UI created that isn't under a test partition.
  const players = await ddb.send(new QueryCommand({ TableName: ENV.TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :s)',
    ExpressionAttributeValues: { ':p': 'PLAYER', ':s': `zz e2e walkin ${run}` } }));
  for (const p of players.Items ?? []) track.partition(p.PK);
  const exp = await ddb.send(new QueryCommand({ TableName: ENV.TABLE, KeyConditionExpression: 'PK = :p', FilterExpression: 'contains(note, :r)',
    ExpressionAttributeValues: { ':p': 'EXPENSE', ':r': run } }));
  for (const e of exp.Items ?? []) track.key({ PK: e.PK, SK: e.SK });
  const k = await ddb.send(new QueryCommand({ TableName: ENV.TABLE, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p',
    ExpressionAttributeValues: { ':p': 'KIOSK' } }));
  for (const d of k.Items ?? []) if (String(d.deviceId).startsWith(`e2e-ui-${run}`)) track.key({ PK: d.PK, SK: d.SK });
  const notices = await ddb.send(new QueryCommand({ TableName: ENV.TABLE, KeyConditionExpression: 'PK = :p', FilterExpression: 'contains(#t, :r)',
    ExpressionAttributeNames: { '#t': 'text' }, ExpressionAttributeValues: { ':p': 'NOTICE', ':r': run } }));
  for (const n of notices.Items ?? []) track.key({ PK: n.PK, SK: n.SK });
  // An announcement this run posted (if a step failed before taking it down).
  const ann = await currentAnnouncement();
  if (ann) {
    const meta = await ddb.send(new GetCommand({ TableName: ENV.TABLE, Key: { PK: `ANN#${ann.announceId}`, SK: 'META' } }));
    if (String(meta.Item?.text ?? '').includes(run)) {
      track.key({ PK: 'CURRENT', SK: 'ANNOUNCE' });
      track.partition(`ANN#${ann.announceId}`);
    }
  }
  await cleanup();
});

async function openAdmin(page: Page, tab = 'overview') {
  await signIn(page, admin, `/admin?tab=${tab}`);
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30000 });
}

test('every admin tab loads', async ({ page }) => {
  const w = watch(page);
  await openAdmin(page);
  for (const [tab, heading] of [
    ['Overview', 'Overview'], ['Sessions', 'Sessions'], ['Players', 'Players'], ['Payments', 'Payments'],
    ['Expenses', 'Expenses'], ['Kiosks', 'Kiosks'],
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
  }
  w.assertClean();
});

test('confirming a player’s cash on the Payments tab credits them', async ({ page }) => {
  const w = watch(page);
  const player = await makeUser({ label: 'payer' });
  const cashier = await makeCashier();
  // The player pays from their phone (through the real API).
  const a = await cog.send(new C.InitiateAuthCommand({ ClientId: ENV.CLIENT, AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: player.email, PASSWORD: player.password } }));
  const r = await fetch(`${ENV.BASE}/api/me/pay-cash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult!.IdToken}` },
    body: JSON.stringify({ adminId: cashier.adminId, amountCents: 1000 }),
  });
  expect(r.status).toBe(201);

  await openAdmin(page, 'payments');
  const row = page.locator('tr', { hasText: player.name });
  await expect(row).toContainText('$10.00');
  await expect(row).toContainText(cashier.name);
  await row.getByRole('button', { name: 'Confirm' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm payment' }).click();
  await expect(row).toHaveCount(0);
  expect((await getPlayer(player.playerId))?.balanceCents).toBe(1000);
  w.assertClean();
});

test('clear a player’s unpaid debt with a credit (not counted as income)', async ({ page }) => {
  const w = watch(page);
  const debtor = await makeUser({ label: 'debtor', balanceCents: -1500 });
  await openAdmin(page, 'players');
  const row = page.locator('tr', { hasText: debtor.name });
  await expect(row).toContainText('$15.00');
  await page.getByRole('button', { name: `Actions for ${debtor.name}` }).click();
  await page.getByRole('menuitem', { name: /Clear debt/ }).click();
  const d = page.getByRole('dialog');
  await expect(d.getByRole('heading', { name: `Clear ${debtor.name}’s debt` })).toBeVisible();
  await expect(d.getByLabel('Amount (USD)')).toHaveValue('15.00'); // prefilled with what they owe
  await expect(d.getByLabel('Reason')).toHaveValue('Forgave unpaid sessions');
  await expect(d).toContainText('New balance: $0.00');
  await d.getByRole('button', { name: 'Clear debt' }).click();
  await expect(page.getByText(`Credited ${debtor.name} $15.00. Balance is now $0.00.`)).toBeVisible();
  expect((await getPlayer(debtor.playerId))?.balanceCents).toBe(0);
  const audit = await ddb.send(new QueryCommand({ TableName: ENV.TABLE, KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': `PLAYER#${debtor.playerId}`, ':s': 'ADJUST#' } }));
  const a0 = audit.Items?.[0];
  expect([a0?.deltaCents, a0?.note, a0?.bySub]).toEqual([1500, 'Forgave unpaid sessions', admin.sub]);
  w.assertClean();
});

test('club notice: post without notifying, players see it, take it down', async ({ page }) => {
  const w = watch(page);
  const text = `ZZ E2E gym closed for maintenance ${run}`;
  await openAdmin(page);
  const card = page.locator('[data-slot=card]', { hasText: 'Club notices' });
  if (await card.getByRole('button', { name: 'New notice' }).count()) await card.getByRole('button', { name: 'New notice' }).click();
  await card.getByLabel('Notice', { exact: true }).fill(text);
  await card.getByRole('button', { name: '1 week' }).click();
  await card.getByRole('checkbox').uncheck();
  await card.getByRole('button', { name: 'Post notice' }).click();
  await expect(page.getByText('Notice posted.')).toBeVisible();
  await expect(card.locator('p', { hasText: text })).toBeVisible();

  await page.goto('/player');
  await expect(page.getByText(text)).toBeVisible({ timeout: 30000 });

  await page.goto('/admin?tab=overview');
  const item = page
    .locator('[data-slot=card]', { hasText: 'Club notices' })
    .locator('div.rounded-lg', { has: page.getByText(text, { exact: true }) });
  await item.getByLabel('Take down notice').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Take down' }).click();
  await expect(page.getByText(text)).toHaveCount(0);
  w.assertClean();
});

test('session announcement: post, RSVP from the account page, take down', async ({ page }) => {
  const existing = await currentAnnouncement();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  test.skip(existing?.date === today, 'alpha already has an announcement up today; not replacing it');
  const w = watch(page);
  const text = `ZZ E2E ball tonight 6:00 ${run}`;
  await openAdmin(page, 'sessions');
  const card = page.locator('[data-slot=card]', { hasText: 'Announce today’s session' });
  await card.getByLabel('Announcement').fill(text);
  await card.getByRole('button', { name: 'Post announcement' }).click();
  await expect(page.locator('[data-slot=card]', { hasText: text }).first()).toBeVisible();

  await page.goto('/player');
  const ann = page.locator('[data-slot=card]', { hasText: text });
  await expect(ann).toBeVisible({ timeout: 30000 });
  await ann.getByRole('button', { name: 'I’m in' }).click();
  await expect(ann.getByText('1 in')).toBeVisible();
  await expect(ann.locator('span.rounded-full', { hasText: admin.name })).toBeVisible();
  await ann.getByRole('button', { name: 'Maybe' }).click();
  await expect(ann.getByText('1 maybe')).toBeVisible();

  await page.goto('/admin?tab=sessions');
  await page.getByLabel('Take down announcement').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Take down' }).click();
  await expect(page.getByText(text)).toHaveCount(0);
  w.assertClean();
});

test('expenses: add one, see it in the season, delete it', async ({ page }) => {
  const w = watch(page);
  const note = `ZZ E2E game balls ${run}`;
  await openAdmin(page, 'expenses');
  await page.getByRole('button', { name: 'Add expense' }).first().click();
  const d = page.getByRole('dialog');
  await d.getByRole('radio', { name: /Basketballs/i }).click();
  await d.getByLabel('Amount ($)').fill('64.99');
  await d.getByLabel('Note (optional)').fill(note);
  await d.getByRole('button', { name: 'Add expense' }).click();
  const row = page.locator('tr', { hasText: note });
  await expect(row).toContainText('$64.99');
  // Switch to this quarter: it's still listed, and the totals say "this quarter".
  const period = page.getByLabel('Period');
  const opts = await period.locator('option').allTextContents();
  expect(opts[0]).toBe('Whole season');
  await period.selectOption({ index: opts.length - 1 });
  await expect(page.getByText('Spent this quarter')).toBeVisible();
  await expect(page.locator('tr', { hasText: note })).toContainText('$64.99');
  await period.selectOption({ label: 'Whole season' });
  await expect(page.getByText('Spent this season')).toBeVisible();
  // The granted-passes switch adds them into the payments card, and turns back off.
  const sw = page.getByRole('switch', { name: 'Count granted passes as paid' });
  await sw.click();
  await expect(page.getByText('Payments + granted passes')).toBeVisible();
  await sw.click();
  await expect(page.getByText('Payments received')).toBeVisible();
  await row.getByLabel('Delete expense').click();
  await page.getByRole('alertdialog').getByRole('button', { name: /Delete/ }).click();
  await expect(page.locator('tr', { hasText: note })).toHaveCount(0);
  w.assertClean();
});

test('add a kiosk-only player with contact details', async ({ page }) => {
  const w = watch(page);
  const name = `ZZ E2E Walkin ${run}`;
  await openAdmin(page, 'players');
  await page.getByRole('button', { name: 'Add player' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Name').fill(name);
  await d.getByLabel('Phone (optional)', { exact: true }).fill('(415) 555-0166');
  await d.getByLabel('Emergency contact (optional)').fill('ZZ E2E Sibling');
  await d.getByLabel('Emergency contact’s phone (optional)').fill('5105550166');
  await d.getByLabel('Kiosk PIN (optional)').fill('2468');
  await d.getByRole('button', { name: 'Add player' }).click();
  await expect(page.getByText(`${name} added.`)).toBeVisible();
  const row = page.locator('tr', { hasText: name });
  // The list doesn't show contact details; tapping the player does.
  await expect(row).not.toContainText('555-0166');
  await row.getByText(name).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('(415) 555-0166');
  await expect(sheet).toContainText('ZZ E2E Sibling');
  await expect(sheet.locator('a[href="tel:+15105550166"]')).toHaveCount(1);
  await expect(sheet).toContainText('Added by an admin (kiosk only)');
  await expect(sheet).toContainText('Pay as you go');
  await page.keyboard.press('Escape');
  // An account holder's email and statuses.
  await page.locator('tr', { hasText: admin.name }).getByText(admin.name).click();
  await expect(page.getByRole('dialog')).toContainText(admin.email);
  await expect(page.getByRole('dialog')).toContainText('Signed up in the app');
  w.assertClean();
});

test('pair a kiosk (QR + code shown once), then remove it', async ({ page }) => {
  const w = watch(page);
  const id = `e2e-ui-${run}`;
  await openAdmin(page, 'kiosks');
  await page.getByRole('button', { name: 'Pair a kiosk' }).first().click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Device ID').fill(id);
  await d.getByLabel('Label (optional)').fill('ZZ E2E side door');
  await d.locator('button[type=submit]').click();
  await expect(d.getByText('Scan with the kiosk')).toBeVisible();
  await expect(d.locator('img')).toBeVisible(); // the pairing QR
  await d.getByText('Enter the code by hand instead').click();
  await expect(d.getByText(id)).toBeVisible();
  await d.getByRole('button', { name: 'Done' }).click();
  const row = page.locator('tr', { hasText: 'ZZ E2E side door' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Remove/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /Remove/ }).click();
  await until(async () => (await page.locator('tr', { hasText: 'ZZ E2E side door' }).count()) === 0, 15000, 'kiosk removed');
  w.assertClean();
});
