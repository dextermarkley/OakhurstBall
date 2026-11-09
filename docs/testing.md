# Testing

Every change is tested on **alpha** (https://alpha.oakhurst-ball.org) before it
can be promoted to prod:

```bash
scripts/deploy-alpha.sh                      # deploy the committed tree to alpha
scripts/test-alpha.sh                        # everything, ~15 min; records the commit as tested
scripts/promote.sh --approved-by-dexter <sha>   # refuses unless that commit passed
```

`scripts/test-alpha.sh` first closes any session open on alpha (`scripts/close-alpha-session.mjs`), since several suites refuse to run while one is open.

`scripts/test-alpha.sh --quick` runs the unit and API suites only (no browser); it
does not count for promotion. Output goes to `test-results/alpha-<sha>.log`; the
browser report (screenshots and traces of failures) opens with
`cd e2e && npx playwright show-report`.

All suites create throwaway data on alpha (Cognito users, players, kiosks, all
named `ZZ …` / `agent-…@oakhurst-ball.org`) and remove it at the end. They notify
nobody real: cash goes to cashier records with no account, and Stripe runs in
test mode.

## 1. Unit tests (`npm test` in `backend/` and `frontend/`)

Pure logic: Stripe webhook signatures, plans and periods, cash amounts, expense
validation, name/email/phone cleaning, payment views (no tokens leak), sealed
pagination cursors, contact validation.

## 2. API suites (`backend/test/live-*.mjs`)

| Suite | Covers |
|---|---|
| smoke | kiosk check-in, daily fee, card paths, errors aren't 500s |
| security | kiosk auth, PIN lockout, pending-cash cap, hashed confirm tokens, link expiry, self-confirm blocked, admin caps + audit, headers, CORS |
| pay-now | cash from the player page, admin confirm/deny, $5 steps, passes keep their price |
| push | Web Push keys, subscribe validation, ownership, dead-device cleanup |
| approval | chat approval gate, sign-up trigger notifies admins only |
| agreements | waiver + rules signing, minors, immutability |
| kiosk-remove | pairing (admins only), removal locks the kiosk out |
| kiosk-admin | only an admin can generate a kiosk pairing code: players, edited or unsigned tokens, the other stack's admins, kiosk credentials and path tricks are all refused and write nothing |
| expenses | add/edit/delete, season totals |
| community | announcements + RSVP, chat text/images/deletes, upload limits |
| sessions | open/close, check-in once per session, fees, limits, defer |
| plans | quarter/year passes by card and cash, refunds of the day's fee |
| freeday | free days and their refunds |
| kiosk-agreement | unsigned players sign on the kiosk before checking in |
| scale | three years of history: every list pages correctly, exact totals, cursors sealed and tamper-proof |

Run one: `cd backend && AWS_REGION=us-west-2 node test/live-<name>.mjs`.

## 3. Browser suites (`e2e/`, Playwright + real WebKit)

| Spec | Device | What a person does |
|---|---|---|
| signup | iPhone | sign up (every validation), confirm, contact saved from sign-up, waiver, chat says "waiting for approval" |
| player | iPhone | one-time contact step for older accounts; account page totals, history "Show older", edit contact + PIN; Pay now with cash |
| stripe | iPhone | Pay now by card through Stripe Checkout (test card), credit lands; a refund in Stripe takes it back through the webhook |
| chat | 2 iPhones | two members chat: text, a photo, live updates, deletes |
| admin | desktop | every tab (no separate Admins tab: admins are managed from Players); confirm a player's cash; post + take down a notice; announcement with RSVP; expenses; add a kiosk-only player with contact; pair and remove a kiosk |
| kiosk | iPad + desktop | admin opens the gym; kiosk check-in with wrong/right PIN; a player at the limit pays cash, admin confirms, kiosk checks them in; admin closes the gym |
| layout | phone, tablet, desktop | every screen loads with no errors and nothing sticks out sideways |

Run one: `cd e2e && npx playwright test kiosk`. Every browser test also fails on
any page crash or server error (5xx) seen along the way.

Two specs use alpha's single "current" items and skip rather than interfere:
the kiosk spec if a session is already open on alpha, the announcement test if
an announcement is already up today.
