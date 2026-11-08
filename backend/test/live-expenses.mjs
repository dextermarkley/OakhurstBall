// Live test of expenses against the deployed stack: throwaway admin + player,
// add/edit/move/delete, season totals, admin-only. Deletes everything it made.
//   AWS_REGION=us-west-2 node test/live-expenses.mjs
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand, AdminDeleteUserCommand, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { BASE, TABLE, POOL, CLIENT } from './env.mjs';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const hex = (n) => randomBytes(n).toString('hex');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (!cond) failures++;
};

const users = [];
async function login(label, admin) {
  const email = `agent-exp-${label}-${hex(3)}@oakhurst-ball.org`;
  const password = `Aa1${hex(12)}`;
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: `ZZ Exp ${label}` }],
  }));
  users.push(email);
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: email, Password: password, Permanent: true }));
  if (admin) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'admin' }));
  const a = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const H = { 'content-type': 'application/json', authorization: `Bearer ${a.AuthenticationResult.IdToken}` };
  return async (method, path, body) => {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
}

const mine = new Set();
try {
  const A = await login('admin', true);
  const P = await login('player', false);

  let r = await A('GET', '/admin/expenses');
  const before = r.body;
  check('report loads for the current season', r.status === 200 && before.season.current === true && typeof before.totalCents === 'number', r);

  r = await P('GET', '/admin/expenses');
  check('players cannot see expenses', r.status === 403, r.status);
  r = await P('POST', '/admin/expenses', { date: today, category: 'facility', amountCents: 100 });
  check('players cannot add expenses', r.status === 403, r.status);

  r = await A('POST', '/admin/expenses', { date: today, category: 'snacks', amountCents: 100 });
  check('unknown category rejected', r.status === 400, r);
  r = await A('POST', '/admin/expenses', { date: today, category: 'facility', amountCents: -1 });
  check('negative amount rejected', r.status === 400, r);

  r = await A('POST', '/admin/expenses', { date: today, category: 'facility', amountCents: 12345, note: 'ZZ test gym rental' });
  const fac = r.body?.expense;
  if (fac) mine.add(fac.cursor);
  check('add a facility expense', r.status === 201 && fac?.amountCents === 12345 && fac?.createdByName === 'ZZ Exp admin', r);
  r = await A('POST', '/admin/expenses', { date: today, category: 'basketballs', amountCents: 5999 });
  const balls = r.body?.expense;
  if (balls) mine.add(balls.cursor);
  check('add a basketballs expense', r.status === 201, r);

  r = await A('GET', '/admin/expenses');
  const after = r.body;
  check('season total goes up by both', after.totalCents - before.totalCents === 12345 + 5999, { before: before.totalCents, after: after.totalCents });
  check('category totals', after.byCategory.facility - before.byCategory.facility === 12345 && after.byCategory.basketballs - before.byCategory.basketballs === 5999, after.byCategory);
  check('this month includes them', after.monthCents - before.monthCents === 12345 + 5999, after.monthCents);
  check('facility recorded this month', after.facilityThisMonth === true, after.facilityThisMonth);
  check('last facility amount remembered for next time', after.lastAmounts.facility === 12345, after.lastAmounts);
  check('both listed', after.expenses.some((e) => e.expenseId === fac.expenseId) && after.expenses.some((e) => e.expenseId === balls.expenseId), after.expenses.length);

  // Move the basketballs back to the start of the season (date is part of the key).
  const start = after.season.start;
  r = await A('POST', '/admin/expenses/update', { cursor: balls.cursor, date: start, category: 'basketballs', amountCents: 6500, note: 'ZZ 2 balls' });
  const moved = r.body?.expense;
  if (moved) { mine.delete(balls.cursor); mine.add(moved.cursor); }
  check('edit amount and move the date', r.status === 200 && moved?.date === start && moved?.amountCents === 6500 && moved?.expenseId === balls.expenseId, r);
  r = await A('GET', '/admin/expenses');
  check('old entry gone, moved one present once', r.body.expenses.filter((e) => e.expenseId === balls.expenseId).length === 1 && r.body.expenses.find((e) => e.expenseId === balls.expenseId)?.date === start, r.body.expenses.length);
  check('this month no longer counts the moved one', r.body.monthCents - before.monthCents === 12345 || start.slice(0, 7) === today.slice(0, 7), r.body.monthCents);

  r = await A('POST', '/admin/expenses/update', { cursor: balls.cursor, date: start, category: 'basketballs', amountCents: 1 });
  check('editing a stale cursor → 404', r.status === 404, r);

  r = await A('GET', `/admin/expenses?season=${after.season.year - 1}`);
  check('previous season excludes this season', r.status === 200 && !r.body.expenses.some((e) => e.expenseId === fac.expenseId) && r.body.season.current === false, r.body?.season);
  r = await A('GET', '/admin/expenses?season=abc');
  check('bad season rejected', r.status === 400, r);

  for (const c of [...mine]) {
    r = await A('POST', '/admin/expenses/delete', { cursor: c });
    if (r.status === 200) mine.delete(c);
  }
  check('delete both', mine.size === 0, [...mine]);
  r = await A('GET', '/admin/expenses');
  check('totals back to where they were', r.body.totalCents === before.totalCents, { before: before.totalCents, now: r.body.totalCents });
  r = await A('POST', '/admin/expenses/delete', { cursor: fac.cursor });
  check('deleting again → 404', r.status === 404, r);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  for (const c of mine) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'EXPENSE', SK: c } })).catch(() => {});
  // Player profiles created by the post-confirmation trigger? These users are
  // created by admin API (no trigger), so there are none to remove.
  for (const u of users) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u })).catch(() => {});
  const left = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk', FilterExpression: 'begins_with(note, :z)', ExpressionAttributeValues: { ':pk': 'EXPENSE', ':z': 'ZZ' } }));
  console.log(`cleanup: ${users.length} users; leftover test expenses: ${left.Items?.length ?? 0}`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
