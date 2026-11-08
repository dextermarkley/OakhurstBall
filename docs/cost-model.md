# Cost model

Target: **~$0/month at idle**, pay-per-use only. No static-cost infrastructure.

## What we use and why it's cheap

| Service            | Billing model                | Idle cost | At club scale (~100 users) |
|--------------------|------------------------------|-----------|----------------------------|
| API Gateway (HTTP) | per request (~$1 / million)  | $0        | pennies                    |
| Lambda             | per invocation + GB-sec      | $0        | pennies (free tier covers) |
| DynamoDB           | **on-demand** (per request)  | $0        | pennies                    |
| Cognito            | per MAU; free under 10k MAU  | $0        | $0                         |
| S3 (chat images)  | per GB stored + requests     | ~cents    | cents                      |
| SES (email)        | ~$0.10 per 1,000 emails      | $0        | cents                      |
| Route 53           | hosted zone $0.50 / month    | $0.50     | $0.50 / month              |

## Deliberately avoided (static-cost traps)

- **EC2 / Fargate always-on** — hourly charge even when idle. ❌
- **NAT Gateway** — ~$32/mo just to exist. ❌ (Lambdas run outside VPC)
- **RDS / Aurora provisioned** — hourly. ❌ (DynamoDB instead)
- **ALB / NLB** — hourly. ❌ (API Gateway instead)
- **Cognito advanced security / SMS MFA** — avoid SMS MFA (per-message); TOTP is free.
- **Provisioned DynamoDB / autoscaling** — on-demand avoids idle RCU/WCU charges.

## The one fixed line

**Route 53**: the hosted zone for the club domain costs $0.50 per month. Everything
else is pay-per-use.

**SES email**: the cash-confirm email costs about $0.10 per 1,000 emails. A busy week
of 50 cash confirmations is about half a cent. Web push is free.

## Estimate

A club running weekly games, ~100 players, a few hundred check-ins and dozens of
payments per month: **about $0.50/month**, dominated by the Route 53 hosted zone.
