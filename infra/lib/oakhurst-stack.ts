import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2_integ from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2_auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

/** Content hash of every file under a directory (sorted, path + bytes). */
function hashDir(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(path.relative(dir, p)).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

export interface OakhurstStackProps extends cdk.StackProps {
  /**
   * Apex domain, e.g. 'oakhurst-ball.org'. Creates a Route 53 hosted zone, a
   * regional ACM cert (same region as the stack) and an API Gateway custom domain
   * for apex + www. Omit to run on the default execute-api URL only.
   */
  readonly domainName?: string;
}

/**
 * Everything is in ONE region (us-west-2). No CloudFront, no S3: API Gateway's
 * HTTP API serves both the JSON API (/api/*) and the SPA ($default → web Lambda,
 * which ships the built frontend inside its bundle). A regional API Gateway custom
 * domain uses a cert from the same region, so nothing lives in us-east-1.
 */
export class OakhurstStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: OakhurstStackProps) {
    super(scope, id, props);

    const apex = props?.domainName;

    // ───────────────────────────── DynamoDB ──────────────────────────────────
    // Single table, PAY_PER_REQUEST (on-demand) → zero idle cost.
    const table = new dynamodb.Table(this, 'Table', {
      tableName: 'oakhurst',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt', // auto-expire confirm tokens
      removalPolicy: cdk.RemovalPolicy.RETAIN, // never auto-drop the ledger
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ───────────────────────────── Cognito ───────────────────────────────────
    // Admin + Player are real Cognito users, separated by group. Free < 10k MAU.
    const siteName = apex ?? 'the Oakhurst Basketball site';
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'oakhurst-users',
      selfSignUpEnabled: true, // players can register themselves
      signInAliases: { email: true },
      autoVerify: { email: true },
      // Name the app and the site in the email so recipients know what the code
      // is for (the default Cognito email says neither).
      userVerification: {
        emailSubject: 'Your Oakhurst Basketball verification code',
        emailBody:
          'Welcome to Oakhurst Basketball! 🏀<br/><br/>' +
          'Your verification code is <strong>{####}</strong>.<br/><br/>' +
          `Enter it on ${siteName} to finish creating your account. ` +
          'If you did not sign up, you can ignore this email.',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      userInvitation: {
        emailSubject: 'You have been added to Oakhurst Basketball',
        emailBody:
          'You have been added to Oakhurst Basketball 🏀<br/><br/>' +
          'Username: <strong>{username}</strong><br/>' +
          'Temporary password: <strong>{####}</strong><br/><br/>' +
          `Sign in at ${siteName} to set your own password.`,
      },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: true, mutable: true },
        phoneNumber: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      // Email/TOTP only — no SMS MFA (SMS MFA is a per-message cost).
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admin',
      description: 'Club organizers; full access + view-as-player',
    });
    new cognito.CfnUserPoolGroup(this, 'PlayerGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'player',
      description: 'Club members; own balance & attendance',
    });

    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'oakhurst-web',
      authFlows: { userSrp: true, userPassword: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // ──────────────────────── Custom domain (Route 53) ─────────────────────────
    // RETAIN the zone so its nameservers never change once the registrar points at
    // them, even if a deploy rolls back. The cert validates itself through this
    // zone as soon as the registrar delegates to it.
    const hostedZone = apex
      ? new route53.PublicHostedZone(this, 'Zone', { zoneName: apex })
      : undefined;
    hostedZone?.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const certificate =
      apex && hostedZone
        ? new acm.Certificate(this, 'SiteCert', {
            domainName: apex,
            subjectAlternativeNames: [`www.${apex}`],
            validation: acm.CertificateValidation.fromDns(hostedZone),
          })
        : undefined;

    // ───────────────────────────── Lambdas ───────────────────────────────────
    const backendRoot = path.join(__dirname, '..', '..', 'backend');
    const backendLock = path.join(backendRoot, 'package-lock.json');
    const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');

    // The Cognito trigger must NOT reference the user pool in its env, or CDK
    // creates a circular dependency (pool → trigger → pool).
    const dataEnv: Record<string, string> = {
      TABLE_NAME: table.tableName,
      GSI1_NAME: 'GSI1',
    };

    const makeFn = (
      name: string,
      entry: string,
      env: Record<string, string>,
      extraBundling: Partial<BundlingOptions> = {},
    ): NodejsFunction =>
      new NodejsFunction(this, name, {
        functionName: `oakhurst-${name}`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64, // cheaper per ms
        projectRoot: backendRoot,
        depsLockFilePath: backendLock,
        entry: path.join(backendRoot, 'src', 'handlers', entry),
        handler: 'handler',
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        environment: env,
        bundling: { minify: true, sourceMap: true, target: 'node22', ...extraBundling },
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/oakhurst-${name}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });

    const apiFn = makeFn('api', 'api.ts', dataEnv); // players, kiosk, payments, admin
    const confirmFn = makeFn('confirm', 'confirm.ts', dataEnv); // magic-link confirm/deny
    const postAuthFn = makeFn('postauth', 'post-auth.ts', dataEnv); // cognito user → player

    // The SPA ships inside the web Lambda: copy frontend/dist into the bundle.
    if (!fs.existsSync(path.join(frontendDist, 'index.html'))) {
      throw new Error(`Build the frontend first: ${frontendDist}/index.html is missing`);
    }
    const webFn = makeFn(
      'web',
      'web.ts',
      {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      },
      {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_in: string, outputDir: string) => [
            `cp -R "${frontendDist}" "${outputDir}/site"`,
          ],
        },
        // CDK fingerprints only the handler source by default, so a frontend-only
        // change would never redeploy. Include the built site in the hash.
        assetHash: `${hashDir(path.join(backendRoot, 'src'))}-${hashDir(frontendDist)}`,
      },
    );

    table.grantReadWriteData(apiFn);
    table.grantReadWriteData(confirmFn);
    table.grantReadWriteData(postAuthFn);

    // Session check-in fee + payment amounts (cents), the negative-balance limit,
    // session length, and the club's time zone (for session dates).
    for (const [k, v] of Object.entries({
      CLUB_TZ: 'America/Los_Angeles',
      SESSION_HOURS: '5',
      NEGATIVE_LIMIT_CENTS: '1000',
      QUARTER_PASS_CENTS: '8000', // Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar
      YEAR_PASS_CENTS: '32000', // Apr 1 – Mar 31
      DAILY_FEE_CENTS: '500', // charged once per session
      CARD_AMOUNT_CENTS: '2000',
      CASH_AMOUNT_CENTS: '500',
      STRIPE_SECRET_PARAM: '/oakhurst/stripe/secret-key',
      STRIPE_WEBHOOK_PARAM: '/oakhurst/stripe/webhook-secret',
    })) {
      apiFn.addEnvironment(k, v);
      confirmFn.addEnvironment(k, v);
    }

    // Stripe keys are SecureString params you create yourself (never in code or
    // CDK). Read-only access to just that path; the AWS-managed SSM key decrypts.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/oakhurst/stripe/*`],
      }),
    );

    // ───────────────────────── Email (SES) ─────────────────────────────────
    // Cash-confirm links go out by email. The domain is verified in SES through
    // DKIM CNAMEs in the Route 53 zone; a custom MAIL FROM (bounce.<apex>) aligns
    // SPF, and a monitoring-only DMARC record helps inbox placement.
    if (apex && hostedZone) {
      const fromAddress = `no-reply@${apex}`;
      new ses.EmailIdentity(this, 'EmailIdentity', {
        identity: ses.Identity.publicHostedZone(hostedZone),
        mailFromDomain: `bounce.${apex}`,
      });
      new route53.TxtRecord(this, 'Dmarc', {
        zone: hostedZone,
        recordName: '_dmarc',
        values: ['v=DMARC1; p=none;'],
      });
      apiFn.addEnvironment('EMAIL_FROM', `Oakhurst Basketball <${fromAddress}>`);
      // Only this account's identities, and only From the no-reply address.
      apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
          conditions: { StringEquals: { 'ses:FromAddress': fromAddress } },
        }),
      );
    }

    userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postAuthFn);

    // ───────────────────────────── HTTP API ──────────────────────────────────
    // Site and API share one origin, so browsers make no cross-origin calls.
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'oakhurst-api',
      defaultIntegration: new apigwv2_integ.HttpLambdaIntegration('WebInteg', webFn),
    });

    const jwtAuthorizer = new apigwv2_auth.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    const apiIntegration = new apigwv2_integ.HttpLambdaIntegration('ApiInteg', apiFn);
    const confirmIntegration = new apigwv2_integ.HttpLambdaIntegration('ConfirmInteg', confirmFn);

    // Player/admin routes — Cognito JWT required.
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });
    // Kiosk routes — no JWT; the handler checks the x-kiosk-device/x-kiosk-token pair.
    // More specific than /api/{proxy+}, so API Gateway routes here first.
    httpApi.addRoutes({
      path: '/api/kiosk/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    // Stripe return page + webhook — public; both re-verify with Stripe.
    httpApi.addRoutes({
      path: '/api/stripe/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    // Magic-link confirm — the unguessable token in the path is the auth.
    httpApi.addRoutes({
      path: '/api/confirm/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: confirmIntegration,
    });

    // ───────────────────── API Gateway custom domain ──────────────────────────
    if (apex && hostedZone && certificate) {
      for (const [id, name, recordName] of [
        ['Apex', apex, undefined],
        ['Www', `www.${apex}`, 'www'],
      ] as const) {
        const dn = new apigwv2.DomainName(this, `${id}Domain`, { domainName: name, certificate });
        new apigwv2.ApiMapping(this, `${id}Mapping`, { api: httpApi, domainName: dn });
        const target = route53.RecordTarget.fromAlias(
          new route53targets.ApiGatewayv2DomainProperties(dn.regionalDomainName, dn.regionalHostedZoneId),
        );
        new route53.ARecord(this, `${id}A`, { zone: hostedZone, recordName, target });
        new route53.AaaaRecord(this, `${id}AAAA`, { zone: hostedZone, recordName, target });
      }
      new cdk.CfnOutput(this, 'NameServers', {
        value: cdk.Fn.join(', ', hostedZone.hostedZoneNameServers!),
        description: 'Set these as the nameservers for the domain at your registrar',
      });
    }

    const appBaseUrl = apex ? `https://${apex}` : httpApi.apiEndpoint;
    apiFn.addEnvironment('APP_BASE_URL', appBaseUrl); // used in the SMS confirm link
    confirmFn.addEnvironment('APP_BASE_URL', appBaseUrl);

    // ───────────────────────────── Outputs ───────────────────────────────────
    new cdk.CfnOutput(this, 'SiteUrl', { value: appBaseUrl });
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
  }
}
