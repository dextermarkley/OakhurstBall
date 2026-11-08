// The club chat between two approved members: text and a photo (uploaded to S3,
// shown through a signed link), the other member sees both without reloading,
// and a deleted message disappears for them too.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ENV, cleanup, ddb, makeUser, run, signIn, track, watch } from '../lib/fx';

let subs: string[] = [];
test.afterAll(async () => {
  // Messages, deletion markers and quota counters this run left in shared partitions.
  for (const [pk, filter] of [
    ['CHAT', (i: any) => subs.includes(i.sub)],
    ['QUOTA', (i: any) => subs.some((s) => String(i.SK).includes(createHash('sha256').update(s).digest('hex').slice(0, 16)))],
    ['PREFS', (i: any) => subs.some((s) => i.SK === `USER#${s}`)],
  ] as const) {
    const r = await ddb.send(new QueryCommand({ TableName: ENV.TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': pk } }));
    for (const i of r.Items ?? []) if (filter(i)) track.key({ PK: i.PK, SK: i.SK });
  }
  await cleanup();
});

/** A small valid PNG (solid orange), so the browser can decode and resize it. */
function png(w = 64, h = 64) {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([0xe8, 0x73, 0x0c]))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('two members chat: text, a photo, and a delete', async ({ browser }) => {
  const a = await makeUser({ label: 'chatter' });
  const b = await makeUser({ label: 'reader' });
  subs = [a.sub, b.sub];
  const ca = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const cb = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const pa = await ca.newPage();
  const pb = await cb.newPage();
  const wa = watch(pa);
  const wb = watch(pb);

  await signIn(pa, a, '/chat');
  await signIn(pb, b, '/chat');
  await expect(pa.getByText('Oakhurst chat')).toBeVisible({ timeout: 30000 });
  await expect(pb.getByText('Oakhurst chat')).toBeVisible({ timeout: 30000 });

  const text = `ZZ E2E who's got the extra ball? ${run}`;
  await pa.getByLabel('Message', { exact: true }).fill(text);
  await pa.getByLabel('Send').click();
  await expect(pa.getByText(text)).toBeVisible();
  await expect(pb.getByText(text)).toBeVisible({ timeout: 20000 }); // arrives by polling

  // Photo: picked, previewed, uploaded straight to S3, shown via /api/media.
  await pa.locator('input[type=file]').setInputFiles({ name: 'meme.png', mimeType: 'image/png', buffer: png() });
  await expect(pa.getByLabel('Remove image')).toBeVisible();
  await pa.getByLabel('Send').click();
  const img = pb.locator('img[src^="/api/media/"]').last();
  await expect(img).toBeVisible({ timeout: 20000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 15000 }).toBeGreaterThan(0);

  // Only your own messages can be deleted (by members).
  const theirs = pb.locator('div', { has: pb.getByText(text, { exact: true }) }).last();
  await theirs.hover();
  await expect(theirs.getByLabel('Delete message')).toHaveCount(0);

  const mine = pa.locator('div.group', { has: pa.getByText(text, { exact: true }) }).last();
  await mine.hover();
  await mine.getByLabel('Delete message').click();
  const confirmDel = pa.getByRole('alertdialog');
  if (await confirmDel.count()) await confirmDel.getByRole('button', { name: /Delete/ }).click();
  await expect(pa.getByText(text)).toHaveCount(0);
  await expect(pb.getByText(text)).toHaveCount(0, { timeout: 20000 });

  wa.assertClean();
  wb.assertClean();
  await ca.close();
  await cb.close();
});
