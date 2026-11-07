# Payments design

## Plans

| Plan          | Price | Covers |
|---------------|-------|--------|
| Pay as you go | $5    | one session, taken from the balance |
| Quarter pass  | $80   | every check-in for the rest of the quarter |
| Year pass     | $320  | every check-in for the rest of the club year |

The club year starts **April 1**. Quarters restart on **Apr 1, Jul 1, Oct 1 and Jan 1**:
Q1 Apr–Jun · Q2 Jul–Sep · Q3 Oct–Dec · Q4 Jan–Mar. A year is named by both years
("2026–27" = Apr 1 2026 – Mar 31 2027). Boundaries are club-local midnight (CLUB_TZ).
Code: `backend/src/lib/plans.ts`; boundary tests in `test/pure.test.ts`.

- A pass covers the period it is bought in, with no proration.
- **The year pass is only sold in Q1 (Apr 1 – Jun 30).** After that, the remaining
  quarters cost less bought one at a time, so the kiosk and player page hide it and
  the API refuses it. An admin can still record one (for a year pass paid by June 30).
- With a covering pass, check-in costs $0 and the −$10 limit is waived.
- Buying a pass after paying for today's session refunds that $5.
- Already covered → the purchase is refused (a quarter on top of a year included).
  If two purchases race and both get paid, the second becomes balance credit.
- Buy at the kiosk (card QR or cash with admin email confirm), on the player page
  (card), or have an admin record one paid outside the app (Admin → Players → Record pass).

Items: `PLAYER#<pid> / PASS#<periodId>` (periodId `Q2026-3` or `Y2026`), with
`GSI1PK = PASS#<periodId>` for the Admin list. Live test: `node test/live-plans.mjs`.

## Sessions and check-in

- An admin opens a session (Admin → Sessions → Open session). Check-in works only
  while it is open, at the kiosk (name + PIN) or from the player page (Check in).
- A session closes when an admin closes it or 5 hours after it opened
  (`SESSION_HOURS`). The time limit needs no scheduler: a session is "open" only
  while `closesAt` is in the future.
- **Check-in charges $5 once per session.** The attendee row, the session's
  attendee count, the balance debit and the player's history row are written in one
  DynamoDB transaction, so a second check-in in the same session charges nothing.
- **Balances may go down to −$10** (`NEGATIVE_LIMIT_CENTS`). The same transaction
  refuses the check-in if the fee would take the balance below that; the player
  must pay first. On the kiosk, a blocked player who pays is checked in
  automatically once the card clears or the admin confirms the cash.
- The kiosk shows who is checked in and how many; a red dot marks players with a
  negative balance (no amounts are shown on the iPad).
- Admin → Sessions lists every session; click one to see who attended.

Live test: `node test/live-sessions.mjs` (refuses to run while a real session is open).

## Paying at the entrance iPad

After check-in, a player who owes money (or is blocked) can pay:
   - **$20 card** (Stripe Checkout: card, Apple Pay, Google Pay). The iPad shows a QR
     code so players pay on their own phone with their own wallet; "Pay on this
     iPad" is the fallback. The $20 is credit: after today's $5, $15 remains and
     covers the next three check-ins with no payment step.
   - **$5 cash**: player picks the admin they hand it to; that admin gets an SMS with
     a one-tap confirm link.

Amounts are fixed server-side (`DAILY_FEE_CENTS`, `CARD_AMOUNT_CENTS`,
`CASH_AMOUNT_CENTS` on the api Lambda); the kiosk never sends an amount.

## Settlement (exactly once)

Every payment is written `pending`, then settled by one DynamoDB transaction that is
conditioned on `status = pending` and credits the balance. A second settle attempt
fails the condition and does nothing.

- **Cash** settles when the admin taps confirm (or deny) on the SMS link.
- **Card** settles when Stripe says the Checkout session is paid, learned from any of:
  the kiosk polling while the QR is up, the payer's phone landing on `/paid`, or the
  Stripe webhook. Each path re-reads the session from Stripe and checks the payment
  id, amount and currency before crediting. Expired sessions settle as `expired`.

## Stripe setup

Keys live in SSM Parameter Store SecureStrings (free), never in code:

| Parameter                         | Value                    | Required |
|-----------------------------------|--------------------------|----------|
| `/oakhurst/stripe/secret-key`     | `sk_test_…` / `sk_live_…`| yes      |
| `/oakhurst/stripe/webhook-secret` | `whsec_…`                | recommended |

```bash
read -rs SK && aws ssm put-parameter --region us-west-2 \
  --name /oakhurst/stripe/secret-key --type SecureString --value "$SK" --overwrite
```

Webhook endpoint (Stripe Dashboard → Developers → Webhooks):
`https://oakhurst-ball.org/api/stripe/webhook`, events
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.expired`. Store its signing secret in the second parameter.

No redeploy is needed; the Lambda reads the parameters on demand. Until the secret
key exists, the kiosk shows card as unavailable and cash still works.

Fees: Stripe 2.9% + $0.30 → $0.88 on a $20 payment. SNS SMS ≈ $0.0075 per cash text.

## Tests

- `npm test` (backend): webhook signature verification, Pacific day boundary.
- `node test/live-smoke.mjs`: end-to-end against the deployed stack with a throwaway
  kiosk + player (cleaned up after; sends no SMS).
