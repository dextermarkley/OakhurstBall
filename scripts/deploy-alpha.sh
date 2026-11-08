#!/bin/sh
# Build and deploy the current working tree to ALPHA (alpha.oakhurst-ball.org).
# Every change goes here first. Uncommitted changes are allowed on alpha; the
# deployed commit is recorded as <sha>-dirty so promote.sh refuses it.
#   scripts/deploy-alpha.sh
set -eu
cd "$(dirname "$0")/.."
export CDK_DEFAULT_ACCOUNT=124705683281 CDK_DEFAULT_REGION=us-west-2
unset OAKHURST_PROD

SHA=$(git rev-parse --short=12 HEAD)
[ -z "$(git status --porcelain)" ] || SHA="$SHA-dirty"
export OAKHURST_GIT_SHA="$SHA"

echo "== building frontend"
(cd frontend && npm run build >/dev/null)
[ -f frontend/dist/sw.js ] || { echo "frontend build incomplete (no dist/sw.js)"; exit 1; }

echo "== deploying $SHA to alpha"
(cd infra && npx cdk deploy OakhurstBasketballAlpha --require-approval never)

sleep 10
WANT=$(grep -o 'assets/index-[^"]*\.js' frontend/dist/index.html)
GOT=$(curl -s https://alpha.oakhurst-ball.org/ | grep -o 'assets/index-[^"]*\.js' || true)
if [ "$WANT" = "$GOT" ]; then echo "== alpha is serving $WANT ($SHA)"; else echo "== WARNING: alpha serves $GOT, expected $WANT"; exit 1; fi

# Keep the alpha branch on GitHub at what alpha runs (publish-main is what prod runs).
case "$SHA" in *-dirty) ;; *) git push -q origin HEAD:refs/heads/alpha && echo "== pushed $SHA to the alpha branch";; esac
