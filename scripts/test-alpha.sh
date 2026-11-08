#!/bin/sh
# Run every test against ALPHA, for the commit alpha is running:
#   1. unit tests (backend + frontend)
#   2. live API suites (backend/test/live-*.mjs), each makes and removes its own data
#   3. browser end-to-end suites (e2e/, real WebKit, Stripe test mode)
# On a full pass it records the commit in SSM (/oakhurst-alpha/tested-sha);
# scripts/promote.sh refuses to deploy a commit that hasn't passed here.
#   scripts/test-alpha.sh            everything (about 15 minutes)
#   scripts/test-alpha.sh --quick    unit + live API only (no browser)
set -u
cd "$(dirname "$0")/.."
export AWS_REGION=us-west-2 OAKHURST_ENV=alpha

SHA=$(git rev-parse --short=12 HEAD)
ALPHA=$(aws cloudformation describe-stacks --stack-name OakhurstBasketballAlpha \
  --query "Stacks[0].Outputs[?OutputKey=='GitSha'].OutputValue" --output text)
if [ "$ALPHA" != "$SHA" ]; then
  echo "Alpha runs '$ALPHA', but HEAD is $SHA. Run scripts/deploy-alpha.sh first (with a clean tree)."
  exit 2
fi

mkdir -p test-results
LOG="test-results/alpha-$SHA.log"
: > "$LOG"
FAILED=""
step() { # name, command...
  name=$1; shift
  start=$(date +%s)
  printf '%-28s ' "$name"
  if "$@" >> "$LOG" 2>&1; then echo "pass  ($(( $(date +%s) - start ))s)"; else echo "FAIL  ($(( $(date +%s) - start ))s)"; FAILED="$FAILED $name"; fi
  echo "---- end $name" >> "$LOG"
}

echo "Testing $SHA on alpha.oakhurst-ball.org (log: $LOG)"
step unit-backend  sh -c 'cd backend && npm test'
step unit-frontend sh -c 'cd frontend && npm test'
# live-cash is left out on purpose: it notifies a real admin and waits for them.
for t in smoke security pay-now push approval agreements kiosk-remove expenses community \
         sessions plans freeday kiosk-agreement scale; do
  step "live-$t" sh -c "cd backend && node test/live-$t.mjs"
done
if [ "${1:-}" != "--quick" ]; then
  [ -d e2e/node_modules ] || (cd e2e && npm ci --no-audit --no-fund >> "../$LOG" 2>&1)
  step e2e-browser sh -c 'cd e2e && npx playwright test --reporter=list'
fi

echo
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"
  echo "Details in $LOG; browser failures have screenshots and traces: cd e2e && npx playwright show-report"
  exit 1
fi
if [ "${1:-}" = "--quick" ]; then
  echo "All quick tests passed (not recorded: promotion needs the full run)."
  exit 0
fi
aws ssm put-parameter --name /oakhurst-alpha/tested-sha --type String --overwrite \
  --value "$SHA $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
echo "All tests passed on alpha. Recorded $SHA as tested; it can be promoted."
