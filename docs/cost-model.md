# Cost model

Target: **~$0/month at idle**, pay-per-use only. No static-cost infrastructure.

## What we use and why it's cheap

| Service            | Billing model                | Idle cost | At club scale (~100 users) |
|--------------------|------------------------------|-----------|----------------------------|
| API Gateway (HTTP) | per request (~$1 / million)  | $0        | pennies                    |
| Lambda             | per invocation + GB-sec      | $0        | pennies (free tier covers) |
| DynamoDB           | **on-demand** (per request)  | $0        | pennies                    |
| Cognito            | per MAU; free under 10k MAU  | $0        | $0                         |
| S3                 | per GB stored + requests     | ~cents    | cents                      |
| CloudFront         | per GB transferred           | $0        | cents                      |
| SNS SMS            | per message (~$0.0075 each)  | $0        | a few cents / month        |

## Deliberately avoided (static-cost traps)

- **EC2 / Fargate always-on** — hourly charge even when idle. ❌
- **NAT Gateway** — ~$32/mo just to exist. ❌ (Lambdas run outside VPC)
- **RDS / Aurora provisioned** — hourly. ❌ (DynamoDB instead)
- **ALB / NLB** — hourly. ❌ (API Gateway instead)
- **Cognito advanced security / SMS MFA** — avoid SMS MFA (per-message); email/TOTP is free.
- **Provisioned DynamoDB / autoscaling** — on-demand avoids idle RCU/WCU charges.

## The one non-zero line

**SNS SMS**: send-only, no phone-number rental (we use the default shared origination
for transactional US SMS, or a cheap toll-free number if deliverability needs it).
~$0.0075 per confirmation text. A busy week of 50 cash confirmations ≈ $0.38.

> We chose the **one-tap magic link** over two-way SMS specifically to avoid the
> ~$2/mo dedicated two-way number and 10DLC registration. SNS only needs to *send*.

## Estimate

A club running weekly games, ~100 players, a few hundred check-ins and dozens of
payments per month: **well under $1/month**, likely a few cents, dominated by SMS.
