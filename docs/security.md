# Security and abuse protection

What protects the club's money, data and AWS bill, and what an organizer should
still do by hand. Live checks: `AWS_REGION=us-west-2 node backend/test/live-security.mjs`.

## Money

- **Cash needs a second person.** A cash payment names the admin who got the
  money. Nobody can name themselves (matched by account or email), and an admin
  can't confirm a payment of their own on the Admin page (denying is fine).
- **Confirm links are secrets and are treated as such.** Only `sha256(token)` is
  stored (`TOKENH#…` row, `confirmTokenHash` on the payment), players never see
  either, and links stop working after 24 hours in code, not only via TTL.
- **What players see is an allowlist** (`lib/views.ts` `paymentView`).
- **Caps:** 3 pending cash payments per player; a repeat card tap reuses the open
  Stripe Checkout (at most 4 new ones per 25 minutes); admin charge/credit at most
  $1,000 each, to existing players only, with an `ADJUST#` audit row (who, amount,
  note).
- **Stripe refunds and disputes** (`charge.refunded` when fully refunded,
  `charge.dispute.created`) take back what the payment bought (the pass, or the
  amount off the balance) and notify every admin's devices. The Stripe webhook
  endpoint must have those two events enabled (done for the test-mode endpoint;
  repeat for the live endpoint when switching to live keys).
- Every settled payment records `settledBy`: `link`, `admin:<sub>` or `stripe`.

## Accounts

- Admin rights come only from the Cognito `admin` group.
- An email change only takes effect after the new address is verified
  (`keepOriginal`), and admin pushes go to the admin's own account (admin records
  are linked to the Cognito account on their first visit, `linkAdminSub`).
- Names are cleaned on the server (no control, zero-width or bidi characters, at
  most 60 characters); push titles are single lines.

## Pagination cursors

- List cursors are encrypted and signed (AES-256-GCM, per-stack key in SSM
  `/oakhurst/cursor/key` and `/oakhurst-alpha/cursor/key`), bound to the list
  they came from, and expire after 24 hours. They reveal nothing and can't be
  edited or reused on another player's history.

## Kiosk

- Wrong PINs: 5 in 15 minutes locks that player for the window, 20 in a day locks
  them for the day. Setting a new PIN in the app clears the lock.
- Device tokens are 192-bit random values checked with SHA-256 (older scrypt
  hashes are upgraded on first use). Unknown device and wrong token get the same
  answer.

## Floods and cost

- API Gateway throttles (requests/second, shared by everyone): 30 default,
  kiosk POST 3, confirm links 2, media 20. HTTP APIs can't use AWS WAF, so there
  is no per-IP limit; the per-user caps above cover the abusable actions.
- Reserved concurrency caps each Lambda (api 40, web 20, confirm 10, sign-up 10).
- Chat: 12 posts a minute and 40 photos a day per person.
- AWS Budget `oakhurst-monthly` ($25): email at $10 actual, $25 actual, and $25
  forecast.

## Data

- DynamoDB: point-in-time recovery, deletion protection, and daily AWS Backup
  copies kept 35 days. Cognito user pool: deletion protection.
- Lambdas can only read/write items and query (no Scan); S3 access is limited to
  objects under `chat/`.
- API access log: `/aws/apigateway/oakhurst-api` (90 days): time, IP, path,
  status, Cognito sub.

## Browser

- Content-Security-Policy (scripts only from the site; network only to the site,
  Cognito and the chat bucket; no framing), Permissions-Policy (camera for the
  kiosk QR scanner only), HSTS, nosniff. API CORS is limited to the site origin.

## For organizers

- Use a long, unique password on every admin account. (Cognito allows
  authenticator-app 2FA, but the app's sign-in screen doesn't handle the 2FA step
  yet, so don't turn it on until it does.)
- Keep at least two admins, so cash paid by an admin can be confirmed.
- Remove a former admin from the Cognito `admin` group and from Admin → Admins.
