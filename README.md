# Oakhurst Basketball

Payment tracking + check-in app for the Oakhurst Basketball club.
Live at **https://oakhurst-ball.org**.

Fully serverless on AWS, one CDK stack in `us-west-2`. Pay-per-request only; the
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
            DynamoDB (single table) · Cognito · SNS (SMS confirm links)
```

## Components

- **infra/** — AWS CDK (TypeScript), one stack.
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

See `docs/deploy.md` to deploy.
