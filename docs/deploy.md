# Deploy guide

One stack (`OakhurstBasketball`), one region: account `124705683281`, `us-west-2`.
No CloudFront, no S3, nothing in us-east-1.

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

Then Admin → Admins: add yourself with your phone (E.164) to receive confirm texts.

## iPad kiosk

Admin → **iPad kiosks** → enter a device ID (e.g. `court-ipad-1`) → Generate pairing
code. A QR code appears; it encodes `https://oakhurst-ball.org/kiosk#pair=<id>.<token>`
(credentials in the URL fragment, which is never sent to the server).

- Kiosk added to the Home Screen: open it → **Scan pairing QR** (in-app camera scanner).
  Use this one: a Home Screen app has its own storage, separate from Safari.
- Kiosk in Safari: scan with the Camera app and tap the link.
- Fallback: "Enter the code by hand" on the kiosk setup screen.

The code is shown once. Generating again for the same device ID rotates the token; the
old iPad then drops back to the setup screen on its next refresh (within 15 s).
(`scripts/provision-kiosk.mjs` does the same from the CLI.)

## Cash confirmation email (SES)

Cash confirm links are emailed from `no-reply@oakhurst-ball.org` via Amazon SES. The
stack verifies the domain (DKIM CNAMEs, `bounce.` MAIL FROM, `_dmarc` TXT in Route 53).
Each admin needs an email (Admin → Admins → Edit email). Pending cash can also be
confirmed or denied on Admin → Pending payments.

SES starts in its sandbox: it only delivers to verified recipient addresses. Verify an
admin's address with `aws sesv2 create-email-identity --region us-west-2
--email-identity <email>` (they click the link AWS emails them), or request production
access (SES console → Account dashboard → Request production access) so any admin
address works.

SMS is not used: US texts need a registered toll-free/10DLC number (~$2/mo plus a
multi-day carrier registration).
