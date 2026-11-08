#!/bin/sh
# Promote the commit that is on ALPHA to PROD (oakhurst-ball.org).
#
# Only run this after Dexter has approved this exact commit. The script checks:
#   - --approved-by-dexter <sha> is given and matches HEAD
#   - the working tree is clean (prod gets exactly a commit, never local edits)
#   - alpha is running this same commit
#   - that commit passed the full test run on alpha (scripts/test-alpha.sh)
# then deploys prod, checks the live site, and pushes the commit to publish-main.
#   scripts/promote.sh --approved-by-dexter <sha>
set -eu
cd "$(dirname "$0")/.."
export CDK_DEFAULT_ACCOUNT=124705683281 CDK_DEFAULT_REGION=us-west-2 AWS_REGION=us-west-2

SHA=$(git rev-parse --short=12 HEAD)
if [ "${1:-}" != "--approved-by-dexter" ] || [ -z "${2:-}" ]; then
  echo "Refusing: prod deploys need Dexter's approval. Usage: scripts/promote.sh --approved-by-dexter $SHA"
  exit 2
fi
case "$SHA" in "$2"*) ;; *) echo "Refusing: approval is for $2, but HEAD is $SHA"; exit 2;; esac
[ -z "$(git status --porcelain)" ] || { echo "Refusing: uncommitted changes. Commit, deploy to alpha, test, then promote."; exit 2; }

ALPHA=$(aws cloudformation describe-stacks --stack-name OakhurstBasketballAlpha \
  --query "Stacks[0].Outputs[?OutputKey=='GitSha'].OutputValue" --output text)
[ "$ALPHA" = "$SHA" ] || { echo "Refusing: alpha runs '$ALPHA', not $SHA. Run scripts/deploy-alpha.sh and test first."; exit 2; }
TESTED=$(aws ssm get-parameter --name /oakhurst-alpha/tested-sha --query Parameter.Value --output text 2>/dev/null || true)
case "$TESTED" in "$SHA "*) echo "== $SHA passed scripts/test-alpha.sh (${TESTED#* })";;
  *) echo "Refusing: $SHA hasn't passed the full test run on alpha (last passed: ${TESTED:-none}). Run scripts/test-alpha.sh."; exit 2;; esac

export OAKHURST_GIT_SHA="$SHA" OAKHURST_PROD=1
echo "== building frontend for $SHA"
(cd frontend && npm run build >/dev/null)
[ -f frontend/dist/sw.js ] || { echo "frontend build incomplete (no dist/sw.js)"; exit 1; }

echo "== deploying $SHA to PROD"
(cd infra && npx cdk deploy OakhurstBasketball --require-approval never)

sleep 10
WANT=$(grep -o 'assets/index-[^"]*\.js' frontend/dist/index.html)
GOT=$(curl -s https://oakhurst-ball.org/ | grep -o 'assets/index-[^"]*\.js' || true)
[ "$WANT" = "$GOT" ] || { echo "== WARNING: prod serves $GOT, expected $WANT"; exit 1; }
echo "== prod is serving $WANT ($SHA)"

git push -q origin HEAD:publish-main
echo "== pushed $SHA to publish-main"
