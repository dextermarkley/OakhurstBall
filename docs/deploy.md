# Deploy guide

Two stacks, one account and region (`124705683281`, `us-west-2`):

| Stack                     | Site                              | Purpose                              |
|---------------------------|-----------------------------------|--------------------------------------|
| `OakhurstBasketballAlpha` | https://alpha.oakhurst-ball.org   | every change is tested here first    |
| `OakhurstBasketball`      | https://oakhurst-ball.org (+ www) | the real club                        |

Alpha is a full separate copy: its own table (`oakhurst-alpha`), Cognito users,
chat bucket, Lambdas (`oakhurst-alpha-*`), SSM parameters (`/oakhurst-alpha/...`:
its own VAPID keys, the Stripe **test** key, its own Stripe webhook endpoint). It
shares only the Route 53 zone. Its data is test data, and the app shows an
"ALPHA · TEST DATA" badge. Alpha resources are disposable (no deletion
protection, no backups); prod keeps all of those.

## Workflow: alpha first, prod only with Dexter's approval

```bash
scripts/deploy-alpha.sh          # build + deploy the working tree to alpha
cd backend && AWS_REGION=us-west-2 node test/live-<name>.mjs   # live tests hit alpha by default
# ... Dexter tries it on alpha.oakhurst-ball.org and approves commit <sha> ...
scripts/promote.sh --approved-by-dexter <sha>
```

- `deploy-alpha.sh` records the commit as the alpha stack's `GitSha` output
  (`<sha>-dirty` with uncommitted changes) and pushes clean commits to the
  `alpha` branch.
- `promote.sh` refuses unless HEAD is that approved commit, the tree is clean,
  and alpha already runs the same commit. It then deploys prod, checks the live
  site serves the new build, and pushes the commit to `publish-main` (which
  therefore always matches prod).
- The prod stack is only part of the CDK app when `OAKHURST_PROD=1`, which only
  `promote.sh` sets, so `cdk deploy` on its own can only ever reach alpha.
- Live tests choose the stack with `OAKHURST_ENV=alpha` (default) or `prod`
  (`backend/test/env.mjs`).
- Admins on a stage: `node scripts/add-admin.mjs <alpha|prod> <email> "<Name>"`
  (invites by email if they have no account, adds the admin group, the player
  profile and the cash-recipient record).

The stack refuses to synth if `frontend/dist/index.html` is missing; both scripts
build the frontend first. The web Lambda serves `/config.js` from its own
environment (Cognito IDs, stage). First-time only:
`npx cdk bootstrap aws://124705683281/us-west-2` (done).

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

Alpha adds `alpha.oakhurst-ball.org` (its own cert and A/AAAA records) to this zone.

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
