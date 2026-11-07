#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { OakhurstStack } from '../lib/oakhurst-stack';

const app = new cdk.App();

// One stack, one region. Set DOMAIN='' to run without the custom domain.
new OakhurstStack(app, 'OakhurstBasketball', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '124705683281',
    region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
  },
  description: 'Oakhurst Basketball — serverless payment tracking & check-in',
  domainName: process.env.DOMAIN ?? 'oakhurst-ball.org',
});
