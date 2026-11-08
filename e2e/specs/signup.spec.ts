// A brand-new member: sign-up form (with every validation), email confirmation,
// first sign-in, contact details saved from sign-up, waiver, account page.
import { test, expect } from '@playwright/test';
import * as C from '@aws-sdk/client-cognito-identity-provider';
import { ENV, cleanup, cog, ddb, hex, run, track, watch } from '../lib/fx';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

test.afterAll(cleanup);

test('sign up → confirm → contact saved → waiver → account page', async ({ page }) => {
  const w = watch(page);
  const email = `agent-e2e-signup-${run}-${hex(2)}@oakhurst-ball.org`;
  const password = 'Aa1-e2e-signup';
  track.user(email);

  await page.goto('/player');
  await page.getByRole('button', { name: 'Create account' }).click();
  const create = page.locator('form').getByRole('button', { name: 'Create account' });

  // Every required field complains when empty.
  await create.click();
  for (const msg of [
    'Enter your full name',
    'Enter a valid email address',
    'Enter your phone number, like (415) 555-0123',
    'Enter your emergency contact’s name',
    'Enter their phone number, like (415) 555-0123',
    'At least 8 characters',
  ]) {
    await expect(page.getByText(msg)).toBeVisible();
  }

  await page.locator('#name').fill('ZZ E2E Newbie ' + run);
  await page.locator('#email').fill(email);
  await page.locator('#phone').fill('415 555 01'); // too short
  await page.locator('#emergencyName').fill('ZZ E2E Parent');
  await page.locator('#emergencyPhone').fill('(415) 555-0123');
  await page.locator('#password').fill(password);
  await create.click();
  await expect(page.getByText('Enter your phone number, like (415) 555-0123')).toBeVisible();

  await page.locator('#phone').fill('(415) 555-0123'); // same as the emergency number
  await create.click();
  await expect(page.getByText('Your emergency contact needs a different number from yours')).toBeVisible();

  await page.locator('#emergencyPhone').fill('510.555.0199');
  await create.click();
  await expect(page.getByText(/code/i).first()).toBeVisible(); // the "enter the code we emailed" step

  // Stand in for typing the emailed code.
  await cog.send(new C.AdminConfirmSignUpCommand({ UserPoolId: ENV.POOL, Username: email }));

  await page.goto('/player');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // The contact step is skipped (typed at sign-up); the waiver comes next.
  await expect(page.getByRole('heading', { name: 'One more step' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Your contact details')).toHaveCount(0);

  const u = await cog.send(new C.AdminGetUserCommand({ UserPoolId: ENV.POOL, Username: email }));
  const sub = u.UserAttributes!.find((a) => a.Name === 'sub')!.Value!;
  const hit = await ddb.send(
    new QueryCommand({ TableName: ENV.TABLE, IndexName: 'BySub', KeyConditionExpression: 'cognitoSub = :s', ExpressionAttributeValues: { ':s': sub } }),
  );
  const pk = hit.Items?.find((i) => String(i.PK).startsWith('PLAYER#'))?.PK as string;
  expect(pk, 'sign-up made a player profile').toBeTruthy();
  track.partition(pk);

  // Waiver: nothing goes through until everything is filled in.
  await page.getByRole('button', { name: 'Sign and continue' }).click();
  await expect(page.locator('[data-slot=field-error]').first()).toBeVisible();
  await page.getByText(/I’ve read the Club Rules/).click();
  await page.getByRole('radio', { name: /18 or older/ }).click();
  await page.locator('#signedName').fill('ZZ E2E Newbie');
  await page.getByText(/I have read this waiver/).click();
  await page.getByRole('button', { name: 'Sign and continue' }).click();

  await expect(page.getByRole('heading', { name: /^Hi, ZZ/ })).toBeVisible({ timeout: 30000 });
  // The details typed at sign-up are on the account page.
  const card = page.locator('[data-slot=card]', { hasText: 'Contact details' });
  await expect(card.locator('input').nth(0)).toHaveValue('(415) 555-0123');
  await expect(card.locator('input').nth(1)).toHaveValue('ZZ E2E Parent');
  await expect(card.locator('input').nth(2)).toHaveValue('(510) 555-0199');

  // New sign-ups wait for approval before the chat.
  await page.goto('/chat');
  await expect(page.getByText('Waiting for approval')).toBeVisible();
  w.assertClean();
});
