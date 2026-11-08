# Oakhurst Basketball

Payment tracking + check-in app for the Oakhurst Basketball club.
Live at **https://oakhurst-ball.org**. Every change is tested first on
**https://alpha.oakhurst-ball.org** and promoted only with Dexter's approval
(see `docs/deploy.md`).

Fully serverless on AWS, CDK stacks in `us-west-2` (prod + alpha). Pay-per-request only; the
single fixed cost is the Route 53 hosted zone ($0.50/month).

## Architecture

```
 Browser / kiosk ──► oakhurst-ball.org (API Gateway custom domain, regional cert)
                        │
                        ▼
                 API Gateway HTTP API
                   ├─ /api/kiosk/*    → api Lambda      (kiosk device token)
                   ├─ /api/confirm/*  → confirm Lambda  (magic-link token)
                   ├─ /api/*          → api Lambda      (Cognito JWT)
                   └─ $default        → web Lambda      (serves the React SPA)
                        │
            DynamoDB (single table) · Cognito · S3 (chat images) · Web Push
```

## Components

- **infra/** — AWS CDK (TypeScript): one stack class, deployed as prod and alpha.
- **backend/** — Lambda handlers (`api`, `confirm`, `post-auth`, `web`) + shared lib.
- **frontend/** — React SPA: Kiosk, Player, Admin, Confirm. Built into `dist/` and
  bundled into the web Lambda at deploy time. Stack: shadcn/ui (Base UI primitives,
  `base-nova` style) + Tailwind CSS v4, Lucide icons, React Hook Form + Zod forms,
  Recharts charts, installable PWA (vite-plugin-pwa; `/api` and `/config.js` are never
  cached). Brand tokens (navy `--primary`, orange `--brand`) live in `src/index.css`;
  app icons are drawn by `scripts/make-icons.mjs`. Each page is code-split.
- **docs/** — cost model, data model, payments design, deploy guide.

## Roles

| Role   | Where                      | Auth                                          |
|--------|----------------------------|-----------------------------------------------|
| Kiosk  | Shared tablet at the game    | Device token (generated in Admin); name + PIN |
| Player | Member's own phone         | Cognito user                                  |
| Admin  | Organizers                 | Cognito `admin` group; can view as player     |

## Live deployment

| Resource          | Value                                                   |
|-------------------|---------------------------------------------------------|
| Site + API        | https://oakhurst-ball.org (also `www.`)                 |
| execute-api URL   | https://t58r9hff84.execute-api.us-west-2.amazonaws.com  |
| Cognito pool      | `us-west-2_sgaAJES20` / client `2fm9q7bir02ib5upgeeelivdii` |
| DynamoDB table    | `oakhurst`                                              |
| Account / region  | `124705683281` / `us-west-2`                            |

Alpha: table `oakhurst-alpha`, Cognito `us-west-2_5u6ysfKDp` / client
`3sam8fji3f5oupm62iv4ldta8h`.

See `docs/deploy.md` to deploy.
