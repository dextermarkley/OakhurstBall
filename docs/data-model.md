# Data model — DynamoDB single table

One table, `oakhurst` (on-demand). Single-table design keyed by `PK`/`SK`.
A GSI (`GSI1PK`/`GSI1SK`) supports the few access patterns that cut across partitions.

## Entities

### Player
- `PK = PLAYER#<playerId>`
- `SK = PROFILE`
- Attributes: `playerId`, `name`, `email`, `phone`, `pinHash` (scrypt of kiosk PIN),
  `balanceCents` (int; negative = owes money), `cognitoSub` (if they have a login),
  `active`, `createdAt`, `updatedAt`
- `GSI1PK = PLAYER`, `GSI1SK = <lowercase name>` — list/search all players (kiosk picker)

### Admin
- `PK = ADMIN#<adminId>`
- `SK = PROFILE`
- Attributes: `adminId`, `name`, `email` (cash-confirm address), `cognitoSub`, `active`
- `GSI1PK = ADMIN`, `GSI1SK = <lowercase name>` — list admins (cash-payment picker)

### Check-in
- `PK = PLAYER#<playerId>`
- `SK = CHECKIN#<isoTimestamp>`
- Attributes: `playerId`, `eventDate` (YYYY-MM-DD), `at` (iso), `source` (kiosk|player)
- `GSI1PK = EVENT#<eventDate>`, `GSI1SK = CHECKIN#<isoTimestamp>` — roster for a game

### Payment (ledger entry — immutable once confirmed)
- `PK = PLAYER#<playerId>`
- `SK = PAYMENT#<isoTimestamp>#<paymentId>`
- Attributes: `paymentId`, `playerId`, `amountCents`, `method` (cash|card),
  `status` (pending|confirmed|denied|expired), `adminId` (who must confirm),
  `confirmToken` (opaque, for magic link), `confirmTokenExpiresAt` (epoch, TTL),
  `createdAt`, `confirmedAt`, `note`; for a pass purchase also `plan`,
  `periodId`, `periodLabel`, `periodStart`, `periodEnd`, `creditedInstead`
- `GSI1PK = PAYMENT_STATUS#<status>`, `GSI1SK = <isoTimestamp>` — admin "pending" queue

### Confirm-token lookup (for the magic link)
- `PK = TOKEN#<confirmToken>`
- `SK = TOKEN`
- Attributes: `playerId`, `paymentId`, `expiresAt` (epoch, **DynamoDB TTL** auto-deletes)
- Lets the confirm endpoint resolve a token → payment in one GetItem without scanning.

### Kiosk device
- `PK = KIOSK#<deviceId>`
- `SK = PROFILE`
- Attributes: `deviceId`, `label`, `deviceSecretHash`, `active`, `lastSeenAt`

Passes, sessions, announcements, chat and expenses have their own items: see
[payments.md](payments.md) and [community.md](community.md).

## Balance semantics

`balanceCents` on the player is the source of truth, updated **transactionally**
with the payment ledger entry when a payment is confirmed:

- Dues/charges decrement balance (player owes → negative).
- Confirmed payments increment balance.
- Kiosk shows "owes $X" when `balanceCents < 0` and offers the pay flow.

A confirmed payment write is a DynamoDB `TransactWriteItems`:
1. Flip payment `status` pending→confirmed (condition: still pending).
2. `ADD balanceCents :amount` on the player.
3. Delete the TOKEN# item.

This makes double-confirmation impossible (the condition fails the second time).

## Access patterns → index

| Need                                   | Query                                   |
|----------------------------------------|-----------------------------------------|
| Player profile / balance               | Get `PLAYER#id / PROFILE`               |
| Player's payment history               | Query `PLAYER#id`, SK begins `PAYMENT#` |
| Player's check-in history              | Query `PLAYER#id`, SK begins `CHECKIN#` |
| Roster for a game                      | Query GSI1 `EVENT#date`                 |
| All players (kiosk picker)             | Query GSI1 `PLAYER`                     |
| All admins (cash picker)               | Query GSI1 `ADMIN`                      |
| Admin's pending-confirmation queue     | Query GSI1 `PAYMENT_STATUS#pending`     |
| Resolve a magic-link token             | Get `TOKEN#token / TOKEN`               |

## Indexes

- `GSI1` (`GSI1PK`, `GSI1SK`, all attributes): lists such as players A–Z,
  sessions by date, payments by status and date, passes per period.
- `BySub` (`cognitoSub`, keys only, sparse): Cognito account → player/admin
  key. Used for the "who is calling?" lookup on almost every request.

## Pagination and growth

Every Query follows DynamoDB pagination (`backend/src/lib/page.ts`):

- `queryAll` follows `LastEvaluatedKey` for server-side lists that stay small
  (admins, one session's attendees, this period's passes, the pending queue).
  It stops with an error after 50 pages instead of growing silently.
- `queryPage` returns one page plus `nextCursor` for lists sent to browsers. A
  cursor is the base64url `LastEvaluatedKey`, checked to belong to the same
  partition before use (a bad one is a 400).

Paged endpoints (pass `?cursor=`; `nextCursor` is null on the last page):

| Endpoint                | Page | Client                                  |
|-------------------------|------|-----------------------------------------|
| `/api/admin/players`    | 100  | follows all pages (search and totals)   |
| `/api/kiosk/players`    | 200  | follows all pages (picker)              |
| `/api/admin/pending`    | 50   | follows all pages (work queue)          |
| `/api/admin/sessions`   | 25   | "Load older sessions"                   |
| `/api/me/checkins`      | 25   | "Show older" (first page in `/api/me/balance`) |
| `/api/me/payments`      | 25   | "Show older" (first page in `/api/me/balance`) |
| `/api/chat`             | 50   | loads older messages on scroll          |

Totals never come from reading a whole history: a player's all-time check-in
count is `checkinCount` on the profile (each check-in ADDs 1; older profiles
get an exact count once, marked `checkinCountV`), and the six-month attendance
chart reads only that date range. `test/live-scale.mjs` seeds three years of
history on alpha and checks all of the above.
