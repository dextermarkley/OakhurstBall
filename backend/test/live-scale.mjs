// Scale test (ALPHA ONLY): what three years of club history looks like, then
// check every list API pages through it correctly. Seeds directly into the
// table, then removes everything it wrote.
//   - 300 extra players (3 pages of /api/admin/players, 2 of /kiosk/players)
//   - 470 past sessions (~3 a week for 3 years)
//   - one long-time player with 420 check-ins and 320 payments
//   - 120 payments waiting in the pending queue (other players)
//   AWS_REGION=us-west-2 node test/live-scale.mjs
import { createHash, randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import * as C from '@aws-sdk/client-cognito-identity-provider';
import { BASE, TABLE, POOL, CLIENT, STAGE } from './env.mjs';

if (STAGE !== 'alpha') {
  console.error('live-scale seeds thousands of rows: alpha only.');
  process.exit(2);
}
const region = process.env.AWS_REGION ?? 'us-west-2';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const cog = new C.CognitoIdentityProviderClient({ region });
const hex = (n) => randomBytes(n).toString('hex');
const run = hex(3);

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 300)}`);
  if (!cond) failed++;
};

const written = []; // every key we put, for cleanup
async function putAll(items) {
  for (let i = 0; i < items.length; i += 25) {
    let req = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let t = 0; req.length && t < 8; t++) {
      const r = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: req } }));
      req = r.UnprocessedItems?.[TABLE] ?? [];
      if (req.length) await new Promise((s) => setTimeout(s, 200 * (t + 1)));
    }
    if (req.length) throw new Error('BatchWrite left items unprocessed');
  }
  for (const it of items) written.push({ PK: it.PK, SK: it.SK });
}
async function deleteAll() {
  for (let i = 0; i < written.length; i += 25) {
    let req = written.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let t = 0; req.length && t < 8; t++) {
      const r = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: req } }));
      req = r.UnprocessedItems?.[TABLE] ?? [];
      if (req.length) await new Promise((s) => setTimeout(s, 200 * (t + 1)));
    }
  }
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86400000;
const users = [];
async function user(label, admin) {
  const email = `agent-scale-${label}-${run}@oakhurst-ball.org`;
  const password = `Aa1${hex(10)}`;
  const u = await cog.send(new C.AdminCreateUserCommand({ UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: `ZZ Scale ${label}` }] }));
  users.push(email);
  await cog.send(new C.AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  if (admin) await cog.send(new C.AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const a = await cog.send(new C.InitiateAuthCommand({ ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }));
  const sub = u.User.Attributes.find((x) => x.Name === 'sub').Value;
  const H = { authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
  const get = async (path) => {
    const t = Date.now();
    const r = await fetch(BASE + path, { headers: H });
    return { status: r.status, body: await r.json().catch(() => null), ms: Date.now() - t };
  };
  return { sub, get };
}
/** Follow nextCursor to the end; returns all items and the page count. */
async function follow(get, path, key) {
  const items = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await get(path + (cursor ? `${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : ''));
    if (r.status !== 200) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
    items.push(...r.body[key]);
    cursor = r.body.nextCursor;
    pages++;
  } while (cursor && pages < 100);
  return { items, pages };
}

const kiosk = { id: `agent-scale-${run}`, token: randomBytes(24).toString('base64url') };
const now = new Date().toISOString();
try {
  // ── Seed ──
  const heavy = await user('heavy', false);
  const admin = await user('admin', true);
  const heavyId = hex(12);
  const seed = [];
  seed.push({ PK: `PLAYER#${heavyId}`, SK: 'PROFILE', playerId: heavyId, name: 'ZZ Scale Heavy', cognitoSub: heavy.sub,
    balanceCents: 0, active: true, approved: true, createdAt: iso(1100 * DAY), updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: `zz scale heavy ${run}`,
    waiverVersion: '2026-11-07', rulesVersion: '2026-11-07.2', agreedAt: now, signedName: 'ZZ Scale Heavy' });
  for (let i = 0; i < 300; i++) {
    const id = hex(12);
    seed.push({ PK: `PLAYER#${id}`, SK: 'PROFILE', playerId: id, name: `ZZ Scale ${String(i).padStart(3, '0')}`, balanceCents: i % 7 === 0 ? -500 : 0,
      active: true, createdAt: iso(i * DAY), updatedAt: now, GSI1PK: 'PLAYER', GSI1SK: `zz scale ${String(i).padStart(3, '0')} ${run}` });
  }
  for (let i = 0; i < 470; i++) {
    const id = hex(12);
    const opened = iso((i + 1) * 2.3 * DAY);
    seed.push({ PK: `SESSION#${id}`, SK: 'META', sessionId: id, eventDate: opened.slice(0, 10), openedAt: opened,
      closesAt: iso((i + 1) * 2.3 * DAY - 5 * 3600000), closedAt: iso((i + 1) * 2.3 * DAY - 4 * 3600000), openedByName: 'ZZ Scale',
      attendeeCount: 10 + (i % 15), GSI1PK: 'SESSION', GSI1SK: opened });
  }
  let recentExpected = 0;
  const from = new Date(); from.setUTCDate(1); from.setUTCMonth(from.getUTCMonth() - 5);
  const fromYmd = from.toISOString().slice(0, 10);
  for (let i = 0; i < 420; i++) {
    const at = iso((i + 1) * 2.6 * DAY);
    if (at.slice(0, 10) >= fromYmd) recentExpected++;
    seed.push({ PK: `PLAYER#${heavyId}`, SK: `CHECKIN#${at}`, playerId: heavyId, sessionId: hex(12), eventDate: at.slice(0, 10), at, source: 'kiosk', feeCents: 500 });
  }
  for (let i = 0; i < 320; i++) {
    const at = iso((i + 1) * 3.4 * DAY);
    const pid = hex(12);
    seed.push({ PK: `PLAYER#${heavyId}`, SK: `PAYMENT#${at}#${pid}`, paymentId: pid, playerId: heavyId, amountCents: 2000, method: i % 2 ? 'cash' : 'card',
      status: 'confirmed', createdAt: at, settledAt: at, GSI1PK: 'PAYMENT_STATUS#confirmed', GSI1SK: at });
  }
  const others = seed.filter((x) => x.SK === 'PROFILE' && x.playerId !== heavyId).map((x) => x.playerId);
  for (let i = 0; i < 120; i++) {
    const at = iso(i * 3600000 + 60000);
    const pid = hex(12);
    const owner = others[i];
    seed.push({ PK: `PLAYER#${owner}`, SK: `PAYMENT#${at}#${pid}`, paymentId: pid, playerId: owner, amountCents: 500, method: 'cash',
      status: 'pending', createdAt: at, GSI1PK: 'PAYMENT_STATUS#pending', GSI1SK: at, adminId: hex(12) });
  }
  const t0 = Date.now();
  await putAll(seed);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: `KIOSK#${kiosk.id}`, SK: 'PROFILE', deviceId: kiosk.id, label: 'scale', active: true,
    deviceSecretHash: 'sha256:' + createHash('sha256').update(kiosk.token).digest('hex'), createdAt: now } }));
  written.push({ PK: `KIOSK#${kiosk.id}`, SK: 'PROFILE' });
  console.log(`seeded ${seed.length} rows in ${Math.round((Date.now() - t0) / 1000)}s`);
  await new Promise((s) => setTimeout(s, 3000)); // let the indexes catch up

  // ── Player ──
  const me = await heavy.get('/api/me');
  check('account → player lookup works with 300+ players (index)', me.status === 200 && me.body.player?.playerId === heavyId, me.body);
  console.log(`      /api/me ${me.ms} ms`);
  const bal = await heavy.get('/api/me/balance');
  check('balance: first page of 25 check-ins + cursor', bal.body.checkins.length === 25 && !!bal.body.checkinsCursor, bal.body.checkins?.length);
  check('balance: all-time check-ins = 420 (not capped at a page)', bal.body.checkinCount === 420, bal.body.checkinCount);
  const monthTotal = Object.values(bal.body.checkinsByMonth).reduce((a, b) => a + b, 0);
  check(`attendance chart covers 6 months (${recentExpected} check-ins)`, monthTotal === recentExpected, bal.body.checkinsByMonth);
  check('payload has no table keys', !/"PK"|"SK"|GSI1/.test(JSON.stringify(bal.body)));
  console.log(`      /api/me/balance ${bal.ms} ms`);
  const allC = await follow(heavy.get, '/api/me/checkins', 'checkins');
  check('check-in history pages through all 420, no repeats', allC.items.length === 420 && new Set(allC.items.map((x) => x.at)).size === 420, { n: allC.items.length, pages: allC.pages });
  const allP = await follow(heavy.get, '/api/me/payments', 'payments');
  check('payment history pages through all 320, no repeats', allP.items.length === 320 && new Set(allP.items.map((x) => x.paymentId)).size === 320, { n: allP.items.length, pages: allP.pages });
  const sorted = allP.items.every((x, i, a) => i === 0 || a[i - 1].createdAt >= x.createdAt);
  check('payments newest first across pages', sorted);
  // A cursor from someone else's history is refused, not followed.
  const otherCursor = Buffer.from(JSON.stringify({ PK: `PLAYER#${others[0]}`, SK: 'PAYMENT#9' })).toString('base64url');
  const bad = await heavy.get(`/api/me/payments?cursor=${otherCursor}`);
  check('cursor for another player’s partition → 400', bad.status === 400, bad);
  const junk = await heavy.get('/api/me/payments?cursor=%7B%7D');
  check('junk cursor → 400, not 500', junk.status === 400, junk.status);
  const noAdmin = await heavy.get('/api/admin/players');
  check('players can’t list players', noAdmin.status === 403);

  // ── Admin ──
  const pl = await follow(admin.get, '/api/admin/players', 'players');
  const mine = pl.items.filter((p) => p.name.startsWith('ZZ Scale '));
  check('admin players: all 301 seeded players across pages', mine.length === 301 && pl.pages >= 4, { n: mine.length, pages: pl.pages });
  check('admin players: A–Z across pages', pl.items.every((x, i, a) => i === 0 || a[i - 1].name.toLowerCase() <= x.name.toLowerCase()));
  const first = await admin.get('/api/admin/sessions');
  check('admin sessions: page of 25 with a cursor', first.body.sessions.length === 25 && !!first.body.nextCursor, first.body.sessions?.length);
  const ss = await follow(admin.get, '/api/admin/sessions', 'sessions');
  check('admin sessions: all 470 old sessions reachable', ss.items.filter((s) => s.openedByName === 'ZZ Scale').length === 470, { n: ss.items.length, pages: ss.pages });
  const pend = await follow(admin.get, '/api/admin/pending', 'pending');
  check('pending queue: all 120 across pages', pend.items.length >= 120 && pend.pages >= 3, { n: pend.items.length, pages: pend.pages });

  // ── Kiosk ──
  const kget = async (path) => {
    const r = await fetch(BASE + '/api/kiosk' + path, { headers: { 'x-kiosk-device': kiosk.id, 'x-kiosk-token': kiosk.token } });
    return { status: r.status, body: await r.json() };
  };
  const kp = await follow(kget, '/players', 'players');
  check('kiosk picker: all players across pages', kp.items.filter((p) => p.name.startsWith('ZZ Scale ')).length === 301 && kp.pages >= 2, { pages: kp.pages });
  const ks = await kget('/session');
  check('kiosk session still answers', ks.status === 200);
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await deleteAll();
  for (const u of users) await cog.send(new C.AdminDeleteUserCommand({ UserPoolId: POOL, Username: u })).catch(() => {});
  console.log(`cleanup: deleted ${written.length} rows, ${users.length} users`);
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
