#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { OakhurstStack } from '../lib/oakhurst-stack';

// Two stacks, one account, one region:
//   OakhurstBasketballAlpha  alpha.oakhurst-ball.org  where every change is tested first
//   OakhurstBasketball       oakhurst-ball.org        the real club
//
// The prod stack is only part of the app when OAKHURST_PROD=1, which only
// scripts/promote.sh sets, after checking the commit is the one on alpha and
// that Dexter approved it. A plain `cdk deploy` can only reach alpha.
const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '124705683281',
  region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
};
const domainName = process.env.DOMAIN ?? 'oakhurst-ball.org';
const gitSha = process.env.OAKHURST_GIT_SHA;

new OakhurstStack(app, 'OakhurstBasketballAlpha', {
  env,
  description: 'Oakhurst Basketball ALPHA (test copy) — alpha.oakhurst-ball.org',
  domainName,
  stage: 'alpha',
  hostedZoneId: process.env.HOSTED_ZONE_ID ?? 'Z09118922J4D2KWQ70LI4', // the prod stack's zone
  gitSha,
});

if (process.env.OAKHURST_PROD === '1') {
  new OakhurstStack(app, 'OakhurstBasketball', {
    env,
    description: 'Oakhurst Basketball — serverless payment tracking & check-in',
    domainName,
    alertEmail: process.env.ALERT_EMAIL ?? 'dextermarkley@gmail.com',
    gitSha,
  });
}
