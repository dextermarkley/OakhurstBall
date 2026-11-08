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
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as budgets from 'aws-cdk-lib/aws-budgets';
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
  /** Who gets the monthly AWS cost alerts (prod only: a budget covers the account). */
  readonly alertEmail?: string;
  /**
   * 'prod' (default) is the real club at <domainName> + www. Any other stage, e.g.
   * 'alpha', is a separate copy of everything (own table, users, bucket, keys) at
   * <stage>.<domainName>, using the prod stack's hosted zone.
   */
  readonly stage?: string;
  /** Required for a non-prod stage with a domain: the prod stack's hosted zone id. */
  readonly hostedZoneId?: string;
  /** Git commit being deployed; shown as the GitSha output. */
  readonly gitSha?: string;
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

    const stage = props?.stage ?? 'prod';
    const prod = stage === 'prod';
    // Prefix for every named resource. Prod keeps the original names ('oakhurst'),
    // because renaming would replace the table and the user pool.
    const P = prod ? 'oakhurst' : `oakhurst-${stage}`;
    const zoneName = props?.domainName;
    const apex = zoneName ? (prod ? zoneName : `${stage}.${zoneName}`) : undefined; // the site's host
    const keep = prod ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // ───────────────────────────── DynamoDB ──────────────────────────────────
    // Single table, PAY_PER_REQUEST (on-demand) → zero idle cost.
    const table = new dynamodb.Table(this, 'Table', {
      tableName: P,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt', // auto-expire confirm tokens
      removalPolicy: keep, // prod: never auto-drop the ledger
      deletionProtection: prod, // prod: the table can't be deleted until this is turned off
    });

    // Daily backups kept 35 days, in a vault that outlives the stack. On top of
    // point-in-time recovery: a separate copy if the table itself is lost.
    if (prod) {
      const backupPlan = backup.BackupPlan.daily35DayRetention(this, 'Backup');
      backupPlan.addSelection('Table', { resources: [backup.BackupResource.fromDynamoDbTable(table)] });
    }
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ───────────────────────────── Cognito ───────────────────────────────────
    // Admin + Player are real Cognito users, separated by group. Free < 10k MAU.
    const siteName = apex ? `https://${apex}` : 'the Oakhurst Basketball site';
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${P}-users`,
      selfSignUpEnabled: true, // players can register themselves
      signInAliases: { email: true },
      autoVerify: { email: true },
      // Name the app and the site in the email so recipients know what the code
      // is for (the default Cognito email says neither).
      userVerification: {
        emailSubject: 'Your Oakhurst Basketball verification code',
        emailBody:
          'Welcome to Oakhurst Basketball!<br/><br/>' +
          'Your verification code is <strong>{####}</strong>.<br/><br/>' +
          `Enter it on the sign-up screen at ${siteName} to finish creating your account. ` +
          'The code expires in 24 hours. If you didn’t sign up, you can ignore this email.',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      userInvitation: {
        emailSubject: 'You have been added to Oakhurst Basketball',
        emailBody:
          'You have been added to Oakhurst Basketball.<br/><br/>' +
          'Username: <strong>{username}</strong><br/>' +
          'Temporary password: <strong>{####}</strong><br/><br/>' +
          `Sign in at ${siteName} and choose a new password. This temporary password expires in 7 days.`,
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
      // Authenticator-app (TOTP) only; no SMS MFA (SMS is a per-message cost).
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // A changed email only takes effect once the new address is verified, so
      // nobody can put someone else's address on their account.
      keepOriginal: { email: true },
      deletionProtection: prod,
      removalPolicy: keep,
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
      userPoolClientName: `${P}-web`,
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
    // Other stages reuse the prod zone (records for <stage>.<domain> only).
    let hostedZone: route53.IHostedZone | undefined;
    if (zoneName && prod) {
      const z = new route53.PublicHostedZone(this, 'Zone', { zoneName });
      z.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      hostedZone = z;
    } else if (zoneName) {
      if (!props?.hostedZoneId) throw new Error(`stage ${stage} needs hostedZoneId (the prod zone)`);
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName });
    }

    const certificate =
      apex && hostedZone
        ? new acm.Certificate(this, 'SiteCert', {
            domainName: apex,
            subjectAlternativeNames: prod ? [`www.${apex}`] : undefined,
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
        functionName: `${P}-${name}`,
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
          logGroupName: `/aws/lambda/${P}-${name}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });

    const apiFn = makeFn('api', 'api.ts', dataEnv); // players, kiosk, payments, admin
    const confirmFn = makeFn('confirm', 'confirm.ts', dataEnv); // magic-link confirm/deny
    const postAuthFn = makeFn('postauth', 'post-auth.ts', dataEnv); // cognito user → player

    // The SPA ships inside the web Lambda: copy frontend/dist into the bundle.
    // sw.js is written last by the build, so its absence means the build is
    // missing or still running: never ship a half-written site.
    for (const f of ['index.html', 'sw.js', 'push-sw.js']) {
      if (!fs.existsSync(path.join(frontendDist, f))) {
        throw new Error(`Build the frontend first (and let it finish): ${frontendDist}/${f} is missing`);
      }
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

    // Item reads/writes and queries only (no Scan, no table admin).
    const DATA_ACTIONS = [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:Query',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:ConditionCheckItem',
    ];
    for (const fn of [apiFn, confirmFn, postAuthFn]) table.grant(fn, ...DATA_ACTIONS);

    // Hard ceilings on concurrent Lambdas, so a flood of requests is capped in
    // cost instead of scaling without limit (the account allows 1000).
    for (const [fn, n] of [
      [apiFn, prod ? 40 : 10],
      [webFn, prod ? 20 : 5],
      [confirmFn, prod ? 10 : 3],
      [postAuthFn, prod ? 10 : 3],
    ] as const) {
      (fn.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = n;
    }

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
      STRIPE_SECRET_PARAM: `/${P}/stripe/secret-key`,
      STRIPE_WEBHOOK_PARAM: `/${P}/stripe/webhook-secret`,
    })) {
      apiFn.addEnvironment(k, v);
      confirmFn.addEnvironment(k, v);
    }

    // Stripe keys are SecureString params you create yourself (never in code or
    // CDK). Read-only access to just that path; the AWS-managed SSM key decrypts.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${P}/stripe/*`],
      }),
    );

    // ───────────────────────── Chat images (S3) ─────────────────────────────
    // Private bucket, pay per use. Browsers upload with a presigned POST and read
    // through short-lived signed URLs (see backend/src/lib/chat.ts).
    const siteOrigins = apex ? (prod ? [`https://${apex}`, `https://www.${apex}`] : [`https://${apex}`]) : ['*'];
    const chatBucket = new s3.Bucket(this, 'ChatMedia', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: keep, // prod: people's photos are never lost to a stack change
      autoDeleteObjects: !prod, // test stages empty the bucket when torn down
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: siteOrigins, allowedHeaders: ['*'], maxAge: 3600 }],
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }],
    });
    // Objects under chat/ only: no listing, no bucket settings.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [chatBucket.arnForObjects('chat/*')],
      }),
    );
    apiFn.addEnvironment('CHAT_BUCKET', chatBucket.bucketName);
    webFn.addEnvironment('CHAT_BUCKET', chatBucket.bucketName); // CSP allows this bucket
    new cdk.CfnOutput(this, 'ChatBucket', { value: chatBucket.bucketName });

    // Web Push VAPID keys (also created outside CDK; see docs/notifications.md).
    // Both functions settle payments, and settling notifies the player.
    // The sign-up trigger notifies admins of new accounts.
    for (const fn of [apiFn, confirmFn, postAuthFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${P}/push/*`],
        }),
      );
      if (!prod) {
        fn.addEnvironment('VAPID_PUBLIC_PARAM', `/${P}/push/vapid-public`);
        fn.addEnvironment('VAPID_PRIVATE_PARAM', `/${P}/push/vapid-private`);
      }
    }
    if (!prod) webFn.addEnvironment('STAGE', stage); // shows a stage badge in the app

    // ───────────────────────── Email domain (SES) ──────────────────────────
    // The app sends no email of its own any more (admins get app notifications),
    // but the domain stays verified in SES (DKIM CNAMEs, MAIL FROM bounce.<apex>,
    // monitoring-only DMARC) so mail from it keeps authenticating if it's needed.
    if (prod && apex && hostedZone) {
      new ses.EmailIdentity(this, 'EmailIdentity', {
        identity: ses.Identity.publicHostedZone(hostedZone),
        mailFromDomain: `bounce.${apex}`,
      });
      new route53.TxtRecord(this, 'Dmarc', {
        zone: hostedZone,
        recordName: '_dmarc',
        values: ['v=DMARC1; p=none;'],
      });
    }

    userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postAuthFn);

    // ───────────────────────────── HTTP API ──────────────────────────────────
    // Site and API share one origin, so browsers make no cross-origin calls.
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${P}-api`,
      defaultIntegration: new apigwv2_integ.HttpLambdaIntegration('WebInteg', webFn),
    });

    const jwtAuthorizer = new apigwv2_auth.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    // ── Throttling ── per-stage limits (requests/second, shared by all callers).
    // HTTP APIs can't use AWS WAF, so these plus per-user caps in the code
    // (PIN lockout, pending-payment caps, chat quotas) are the flood protection.
    const apiStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    apiStage.defaultRouteSettings = { throttlingBurstLimit: 60, throttlingRateLimit: 30 };
    // routeSettings is raw JSON, so the keys use the CloudFormation casing.
    const limit = (rate: number, burst: number) => ({ ThrottlingRateLimit: rate, ThrottlingBurstLimit: burst });
    apiStage.routeSettings = {
      'GET /api/kiosk/{proxy+}': limit(10, 20),
      'POST /api/kiosk/{proxy+}': limit(3, 10),
      'GET /api/confirm/{proxy+}': limit(2, 5),
      'POST /api/confirm/{proxy+}': limit(2, 5),
      'GET /api/stripe/{proxy+}': limit(5, 10),
      'POST /api/stripe/{proxy+}': limit(10, 20),
      'GET /api/media/{proxy+}': limit(20, 60),
    };
    // Access log (who called what, status, latency) for investigating abuse.
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/${P}-api`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    apiStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        t: '$context.requestTime',
        ip: '$context.identity.sourceIp',
        m: '$context.httpMethod',
        p: '$context.path',
        s: '$context.status',
        ms: '$context.responseLatency',
        sub: '$context.authorizer.claims.sub',
        ua: '$context.identity.userAgent',
        id: '$context.requestId',
      }),
    };

    const routes: apigwv2.HttpRoute[] = [];
    const apiIntegration = new apigwv2_integ.HttpLambdaIntegration('ApiInteg', apiFn);
    const confirmIntegration = new apigwv2_integ.HttpLambdaIntegration('ConfirmInteg', confirmFn);

    // Player/admin routes — Cognito JWT required.
    routes.push(...httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    }));
    // Kiosk routes — no JWT; the handler checks the x-kiosk-device/x-kiosk-token pair.
    // More specific than /api/{proxy+}, so API Gateway routes here first.
    routes.push(...httpApi.addRoutes({
      path: '/api/kiosk/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    }));
    // Stripe return page + webhook — public; both re-verify with Stripe.
    routes.push(...httpApi.addRoutes({
      path: '/api/stripe/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    }));
    // Chat images for <img> tags (no token possible) — random ids, signed redirects.
    routes.push(...httpApi.addRoutes({
      path: '/api/media/{proxy+}',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
    }));
    // Magic-link confirm — the unguessable token in the path is the auth.
    routes.push(...httpApi.addRoutes({
      path: '/api/confirm/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: confirmIntegration,
    }));

    // Route throttles name routes, so the stage must be created after them
    // (on a brand-new stack CloudFormation would otherwise make it first).
    for (const r of routes) apiStage.node.addDependency(r);

    // ───────────────────── API Gateway custom domain ──────────────────────────
    if (apex && hostedZone && certificate) {
      const hosts: Array<[string, string, string | undefined]> = prod
        ? [
            ['Apex', apex, undefined],
            ['Www', `www.${apex}`, 'www'],
          ]
        : [['Site', apex, stage]];
      for (const [id, name, recordName] of hosts) {
        const dn = new apigwv2.DomainName(this, `${id}Domain`, { domainName: name, certificate });
        new apigwv2.ApiMapping(this, `${id}Mapping`, { api: httpApi, domainName: dn });
        const target = route53.RecordTarget.fromAlias(
          new route53targets.ApiGatewayv2DomainProperties(dn.regionalDomainName, dn.regionalHostedZoneId),
        );
        new route53.ARecord(this, `${id}A`, { zone: hostedZone, recordName, target });
        new route53.AaaaRecord(this, `${id}AAAA`, { zone: hostedZone, recordName, target });
      }
      if (prod) {
        new cdk.CfnOutput(this, 'NameServers', {
          value: cdk.Fn.join(', ', hostedZone.hostedZoneNameServers!),
          description: 'Set these as the nameservers for the domain at your registrar',
        });
      }
    }

    const appBaseUrl = apex ? `https://${apex}` : httpApi.apiEndpoint;
    apiFn.addEnvironment('APP_BASE_URL', appBaseUrl); // Stripe return URLs
    confirmFn.addEnvironment('APP_BASE_URL', appBaseUrl);
    // Only with a custom domain: the fallback is the API endpoint, which would make
    // the Cognito trigger depend on the API (a CloudFormation cycle). push.ts falls
    // back to a mailto: VAPID subject without it.
    if (apex) postAuthFn.addEnvironment('APP_BASE_URL', appBaseUrl);

    // ───────────────────────────── Cost alarm ─────────────────────────────────
    // The club normally costs a few dollars a month. Email when this month's
    // spend passes $10 so far, or is forecast to pass $25.
    if (prod && props?.alertEmail) {
      const to = [{ subscriptionType: 'EMAIL', address: props.alertEmail }];
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'oakhurst-monthly',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: 25, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 40, thresholdType: 'PERCENTAGE' },
            subscribers: to,
          },
          {
            notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
            subscribers: to,
          },
          {
            notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
            subscribers: to,
          },
        ],
      });
    }

    // ───────────────────────────── Outputs ───────────────────────────────────
    new cdk.CfnOutput(this, 'SiteUrl', { value: appBaseUrl });
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'Stage', { value: stage });
    if (props?.gitSha) new cdk.CfnOutput(this, 'GitSha', { value: props.gitSha, description: 'Commit deployed here' });
  }
}
