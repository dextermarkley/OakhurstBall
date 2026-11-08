// Test fixtures for the browser tests: throwaway Cognito users, player rows,
// cash-recipient admin records, kiosks and seeded history, all on ALPHA, all
// removed again by cleanup(). Everything is named "ZZ E2E …" so leftovers are
// easy to spot.
import { createHash, randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import * as C from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

// ── Alpha only ──
export const ENV = {
  BASE: 'https://alpha.oakhurst-ball.org',
  TABLE: 'oakhurst-alpha',
  POOL: 'us-west-2_5u6ysfKDp',
  CLIENT: '3sam8fji3f5oupm62iv4ldta8h',
  REGION: 'us-west-2',
  PARAM_PREFIX: '/oakhurst-alpha',
};
if (process.env.OAKHURST_ENV && process.env.OAKHURST_ENV !== 'alpha') {
  throw new Error('The browser tests create and delete data: they only run against alpha.');
}

export const SIGNED = { waiverVersion: '2026-11-07', rulesVersion: '2026-11-07.2', signedName: 'ZZ E2E Signer' };
export const PASSWORD = 'Aa1-e2e-' + randomBytes(4).toString('hex');

export const cog = new C.CognitoIdentityProviderClient({ region: ENV.REGION });
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: ENV.REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({ region: ENV.REGION });
export const hex = (n: number) => randomBytes(n).toString('hex');
export const run = hex(3); // tags this run's data
const now = () => new Date().toISOString();

// ── Cleanup tracking ──
const users: string[] = [];
const partitions = new Set<string>(); // PK values to empty completely
const keys: Array<{ PK: string; SK: string }> = [];
export const track = {
  user: (email: string) => users.push(email),
  partition: (pk: string) => partitions.add(pk),
  key: (k: { PK: string; SK: string }) => keys.push(k),
};

export async function cleanup() {
  for (const pk of partitions) {
    let start: any;
    do {
      const r = await ddb.send(
        new QueryCommand({ TableName: ENV.TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': pk }, ExclusiveStartKey: start }),
      );
      for (const it of r.Items ?? []) {
        if (it.paymentId) await del({ PK: `PAYREF#${it.paymentId}`, SK: 'REF' });
        if (it.confirmTokenHash) await del({ PK: `TOKENH#${it.confirmTokenHash}`, SK: 'TOKEN' });
        await del({ PK: it.PK, SK: it.SK });
      }
      start = r.LastEvaluatedKey;
    } while (start);
  }
  for (const k of keys) await del(k);
  for (const e of users) await cog.send(new C.AdminDeleteUserCommand({ UserPoolId: ENV.POOL, Username: e })).catch(() => {});
  partitions.clear();
  keys.length = 0;
  users.length = 0;
}
const del = (Key: { PK: string; SK: string }) => ddb.send(new DeleteCommand({ TableName: ENV.TABLE, Key })).catch(() => {});

// ── Users + players ──
export interface TestUser {
  email: string;
  password: string;
  sub: string;
  playerId: string;
  name: string;
}

export async function makeUser(opts: {
  label: string;
  admin?: boolean;
  signed?: boolean;
  contact?: boolean;
  approved?: boolean;
  balanceCents?: number;
  pin?: string;
}): Promise<TestUser> {
  const email = `agent-e2e-${opts.label}-${run}-${hex(2)}@oakhurst-ball.org`;
  const name = `ZZ E2E ${opts.label[0].toUpperCase()}${opts.label.slice(1)} ${run}`;
  const u = await cog.send(
    new C.AdminCreateUserCommand({
      UserPoolId: ENV.POOL,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
    }),
  );
  track.user(email);
  const sub = u.User!.Attributes!.find((a) => a.Name === 'sub')!.Value!;
  await cog.send(new C.AdminSetUserPasswordCommand({ UserPoolId: ENV.POOL, Username: email, Password: PASSWORD, Permanent: true }));
  if (opts.admin) await cog.send(new C.AdminAddUserToGroupCommand({ UserPoolId: ENV.POOL, Username: email, GroupName: 'admin' }));
  const playerId = hex(12);
  track.partition(`PLAYER#${playerId}`);
  await ddb.send(
    new PutCommand({
      TableName: ENV.TABLE,
      Item: {
        PK: `PLAYER#${playerId}`,
        SK: 'PROFILE',
        playerId,
        name,
        email,
        cognitoSub: sub,
        balanceCents: opts.balanceCents ?? 0,
        active: true,
        approved: opts.approved ?? true,
        createdAt: now(),
        updatedAt: now(),
        GSI1PK: 'PLAYER',
        GSI1SK: name.toLowerCase(),
        ...(opts.signed !== false ? { ...SIGNED, agreedAt: now() } : {}),
        ...(opts.contact !== false ? { phone: '+14155550100', emergencyName: 'ZZ E2E Contact', emergencyPhone: '+15105550100' } : {}),
        ...(opts.pin ? { pinHash: scrypt(opts.pin) } : {}),
      },
    }),
  );
  return { email, password: PASSWORD, sub, playerId, name };
}

/** A kiosk-only player (no account), for the kiosk picker. */
export async function makeKioskPlayer(label: string, balanceCents: number, pin: string) {
  const playerId = hex(12);
  const name = `ZZ E2E ${label} ${run}`;
  track.partition(`PLAYER#${playerId}`);
  await ddb.send(
    new PutCommand({
      TableName: ENV.TABLE,
      Item: {
        PK: `PLAYER#${playerId}`, SK: 'PROFILE', playerId, name, balanceCents, active: true, approved: true,
        createdAt: now(), updatedAt: now(), GSI1PK: 'PLAYER', GSI1SK: name.toLowerCase(), pinHash: scrypt(pin), ...SIGNED, agreedAt: now(),
      },
    }),
  );
  return { playerId, name };
}

import { scryptSync } from 'node:crypto';
function scrypt(s: string) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(s, salt, 32, { N: 16384 }).toString('hex')}`;
}

/** A cash-recipient admin record with no email and no account: nobody is notified. */
export async function makeCashier(label = 'Cashier') {
  const adminId = hex(12);
  const name = `ZZ E2E ${label} ${run}`;
  track.key({ PK: `ADMIN#${adminId}`, SK: 'PROFILE' });
  await ddb.send(
    new PutCommand({ TableName: ENV.TABLE, Item: { PK: `ADMIN#${adminId}`, SK: 'PROFILE', adminId, name, active: true, createdAt: now(), GSI1PK: 'ADMIN', GSI1SK: name.toLowerCase() } }),
  );
  return { adminId, name };
}

export async function makeKiosk() {
  const id = `e2e-${run}-${hex(2)}`;
  const token = randomBytes(24).toString('base64url');
  track.key({ PK: `KIOSK#${id}`, SK: 'PROFILE' });
  await ddb.send(
    new PutCommand({
      TableName: ENV.TABLE,
      Item: { PK: `KIOSK#${id}`, SK: 'PROFILE', deviceId: id, label: `ZZ E2E kiosk ${run}`, active: true,
        deviceSecretHash: 'sha256:' + createHash('sha256').update(token).digest('hex'), createdAt: now(), GSI1PK: 'KIOSK', GSI1SK: `zz e2e ${run}` },
    }),
  );
  return { id, token };
}

/** n past check-ins and confirmed payments, one every 3 days. */
export async function seedHistory(playerId: string, n: number) {
  const items: any[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.now() - (i * 3 + 1) * 86400000).toISOString();
    items.push({ PK: `PLAYER#${playerId}`, SK: `CHECKIN#${at}`, playerId, eventDate: at.slice(0, 10), at, source: 'kiosk', feeCents: 500 });
    const pid = hex(12);
    items.push({ PK: `PLAYER#${playerId}`, SK: `PAYMENT#${at}#${pid}`, paymentId: pid, playerId, amountCents: 2000, method: i % 2 ? 'cash' : 'card',
      status: 'confirmed', createdAt: at, settledAt: at, GSI1PK: 'PAYMENT_STATUS#confirmed', GSI1SK: at });
  }
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [ENV.TABLE]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }));
  }
}

export async function getPlayer(playerId: string) {
  return (await ddb.send(new GetCommand({ TableName: ENV.TABLE, Key: { PK: `PLAYER#${playerId}`, SK: 'PROFILE' } }))).Item;
}
export async function payments(playerId: string) {
  const r = await ddb.send(
    new QueryCommand({ TableName: ENV.TABLE, KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)', ExpressionAttributeValues: { ':p': `PLAYER#${playerId}`, ':s': 'PAYMENT#' } }),
  );
  return r.Items ?? [];
}
/** Poll until fn returns a truthy value (or time out). */
export async function until<T>(fn: () => Promise<T>, ms = 30000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
export async function param(name: string) {
  return (await ssm.send(new GetParameterCommand({ Name: ENV.PARAM_PREFIX + name, WithDecryption: true }))).Parameter!.Value!;
}
export const currentSession = async () => (await ddb.send(new GetCommand({ TableName: ENV.TABLE, Key: { PK: 'CURRENT', SK: 'SESSION' } }))).Item;
export const currentAnnouncement = async () => (await ddb.send(new GetCommand({ TableName: ENV.TABLE, Key: { PK: 'CURRENT', SK: 'ANNOUNCE' } }))).Item;

// ── Browser helpers ──
/** Fail the test on any page crash or server error, wherever it happens. */
export function watch(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return {
    problems,
    assertClean: () => expect(problems, problems.join('\n')).toEqual([]),
  };
}

export async function signIn(page: Page, u: { email: string; password: string }, path = '/player') {
  await page.goto(path);
  await page.locator('#email').fill(u.email);
  await page.locator('#password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Nothing on the page sticks out sideways (the layout fits the screen). */
export async function expectNoOverflow(page: Page) {
  const out = await page.evaluate(() => {
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(`page is ${document.documentElement.scrollWidth}px wide on a ${innerWidth}px screen`);
    for (const box of document.querySelectorAll('[role=dialog], [data-slot=card]')) {
      const b = box.getBoundingClientRect();
      for (const el of box.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || getComputedStyle(el).position === 'fixed') continue;
        // Content inside a sideways-scrolling area (inside this card) is meant to scroll.
        let scroller = el.parentElement;
        while (scroller && scroller !== box && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
        if (scroller && scroller !== box) continue;
        if (r.right > b.right + 1 || r.left < b.left - 1) {
          bad.push(`"${((el as HTMLElement).innerText || el.tagName).trim().slice(0, 40)}" sticks out of its card`);
          break;
        }
      }
    }
    return bad;
  });
  expect(out, out.join('\n')).toEqual([]);
}

/** Pair a browser page as the kiosk (what scanning the pairing QR does). */
export async function pairKiosk(page: Page, k: { id: string; token: string }) {
  await page.goto('/');
  await page.evaluate(([id, token]) => {
    localStorage.setItem('kioskDevice', id);
    localStorage.setItem('kioskToken', token);
  }, [k.id, k.token]);
  await page.goto('/kiosk');
}
