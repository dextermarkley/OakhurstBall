# Data model — DynamoDB single table

One table, `oakhurst` (on-demand). Single-table design keyed by `PK`/`SK`.
A GSI (`GSI1PK`/`GSI1SK`) supports the few access patterns that cut across partitions.

## Entities

### Player
- `PK = PLAYER#<playerId>`
- `SK = PROFILE`
- Attributes: `playerId`, `name`, `email`, `phone`, `pinHash` (bcrypt of kiosk PIN),
  `balanceCents` (int; negative = owes money), `cognitoSub` (if they have a login),
  `active`, `createdAt`, `updatedAt`
- `GSI1PK = PLAYER`, `GSI1SK = <lowercase name>` — list/search all players (kiosk picker)

### Admin
- `PK = ADMIN#<adminId>`
- `SK = PROFILE`
- Attributes: `adminId`, `name`, `phone` (E.164, for SNS), `cognitoSub`, `active`
- `GSI1PK = ADMIN`, `GSI1SK = <lowercase name>` — list admins (cash-payment picker)

### Check-in
- `PK = PLAYER#<playerId>`
- `SK = CHECKIN#<isoTimestamp>`
- Attributes: `playerId`, `eventDate` (YYYY-MM-DD), `at` (iso), `source` (kiosk)
- `GSI1PK = EVENT#<eventDate>`, `GSI1SK = CHECKIN#<isoTimestamp>` — roster for a game

### Payment (ledger entry — immutable once confirmed)
- `PK = PLAYER#<playerId>`
- `SK = PAYMENT#<isoTimestamp>#<paymentId>`
- Attributes: `paymentId`, `playerId`, `amountCents`, `method` (cash|venmo|card),
  `status` (pending|confirmed|denied|expired), `adminId` (who must confirm),
  `confirmToken` (opaque, for magic link), `confirmTokenExpiresAt` (epoch, TTL),
  `createdAt`, `confirmedAt`, `note`
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
