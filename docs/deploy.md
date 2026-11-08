# Deploy guide

One stack (`OakhurstBasketball`), one region: account `124705683281`, `us-west-2`.
No CloudFront. One private S3 bucket (chat images). Nothing in us-east-1.

## Deploy

```bash
cd frontend && npm install && npm run build     # SPA is bundled into the web Lambda
cd ../infra && npm install
export CDK_DEFAULT_ACCOUNT=124705683281 CDK_DEFAULT_REGION=us-west-2
npx cdk deploy
```

The stack refuses to synth if `frontend/dist/index.html` is missing, so always build
the frontend first. There is no config step: the web Lambda serves `/config.js` from
its own environment (Cognito IDs, same-origin API).

First-time only: `npx cdk bootstrap aws://124705683281/us-west-2` (already done).

## Custom domain

`DOMAIN` defaults to `oakhurst-ball.org`. The stack creates:
- Route 53 public hosted zone (RETAIN, so its nameservers never change)
- Regional ACM cert for apex + `www`, DNS-validated through the zone
- API Gateway custom domains for apex + `www`, mapped to the HTTP API
- A/AAAA alias records

The registrar (Hover) must delegate to the zone's four `awsdns` nameservers
(`NameServers` stack output). Check delegation at the registry:

```bash
dig +norecurse NS oakhurst-ball.org @a2.org.afilias-nst.info
```

Run without a domain: `DOMAIN= npx cdk deploy` (site on the execute-api URL).

## Routing

| Path                     | Handler   | Auth                         |
|--------------------------|-----------|------------------------------|
| `/api/kiosk/*`           | api       | kiosk device ID + token      |
| `/api/confirm/*`         | confirm   | token in path                |
| `/api/*`                 | api       | Cognito JWT (authorizer)     |
| everything else          | web (SPA) | none                         |

## First admin

Sign up in the app, then:

```bash
aws cognito-idp admin-add-user-to-group --region us-west-2 \
  --user-pool-id us-west-2_sgaAJES20 --username <your-email> --group-name admin
```

Then Admin → Admins: add yourself with your email to receive cash-confirm emails.

## Kiosk

Admin → **Kiosks** → enter a device ID (e.g. `court-kiosk-1`) → Generate pairing
code. A QR code appears; it encodes `https://oakhurst-ball.org/kiosk#pair=<id>.<token>`
(credentials in the URL fragment, which is never sent to the server).

- Kiosk added to the Home Screen: open it → **Scan pairing QR** (in-app camera scanner).
  Use this one: a Home Screen app has its own storage, separate from Safari.
- Kiosk in Safari: scan with the Camera app and tap the link.
- Fallback: "Enter the code by hand" on the kiosk setup screen.

The code is shown once. Generating again for the same device ID rotates the token; the
old kiosk then drops back to the setup screen on its next refresh (within 15 s).
(`scripts/provision-kiosk.mjs` does the same from the CLI.)

## Cash confirmation

The admin a player picks gets an app notification ("Cash from …") that opens the
one-tap confirm page. Admins need notifications turned on in the installed app; an
admin with none still sees the payment on Admin → Payments and confirms it there.
The app sends no email itself (Cognito still emails sign-up and reset codes). The
domain stays verified in SES (DKIM, `bounce.` MAIL FROM, `_dmarc` TXT) in case
email is needed again.

SMS is not used: US texts need a registered toll-free/10DLC number (~$2/mo plus a
multi-day carrier registration).

## Reset test data

Before launch, wipe everything except the admin account:

```bash
cd backend
node scripts/reset-data.mjs          # dry run: shows what would be deleted
node scripts/reset-data.mjs --yes    # do it
```

Deletes every session, check-in, payment, pass and Cognito user. Keeps
dextermarkley@gmail.com (login, admin group, cash-confirm email, player profile
and PIN, with the balance reset to $0) and the paired kiosks. Options:
`--keep other@example.com` (repeatable), `--include-kiosks` (un-pair kiosks too).
Stripe keys, email setup and the domain are untouched.
