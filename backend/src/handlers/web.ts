// Serves the React SPA from files bundled into this Lambda (copied from
// frontend/dist at CDK bundle time into ./site). Mounted on the HTTP API $default
// route, so the site and the API share one origin and one custom domain.
//
//   /config.js        → generated from env (API base, Cognito IDs)
//   /assets/*         → hashed build files, cached for a year
//   other file paths  → served if present, else 404
//   extension-less    → index.html (client-side routes: /kiosk, /admin, /confirm/x)
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { readFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

const SITE = path.join(process.env.LAMBDA_TASK_ROOT ?? '.', 'site');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt']);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

function configJs(): string {
  const cfg = {
    apiUrl: '', // same origin
    region: process.env.AWS_REGION,
    userPoolId: process.env.USER_POOL_ID,
    userPoolClientId: process.env.USER_POOL_CLIENT_ID,
    venmoHandle: process.env.VENMO_HANDLE ?? 'oakhurst-basketball',
  };
  return `window.OAKHURST_CONFIG = ${JSON.stringify(cfg)};\n`;
}

function serveFile(file: string, cacheControl: string): APIGatewayProxyResultV2 {
  const ext = path.extname(file).toLowerCase();
  const body = readFileSync(file);
  const isText = TEXT.has(ext);
  return {
    statusCode: 200,
    headers: {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': cacheControl,
      ...SECURITY_HEADERS,
    },
    body: isText ? body.toString('utf8') : body.toString('base64'),
    isBase64Encoded: !isText,
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const raw = decodeURIComponent(event.rawPath || '/');

  if (raw === '/config.js') {
    return {
      statusCode: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        ...SECURITY_HEADERS,
      },
      body: configJs(),
    };
  }

  // Resolve inside SITE only (blocks ../ traversal).
  const resolved = path.resolve(SITE, '.' + path.posix.normalize(raw));
  const inside = resolved === SITE || resolved.startsWith(SITE + path.sep);

  if (inside && path.extname(resolved)) {
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      const immutable = raw.startsWith('/assets/');
      return serveFile(resolved, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
  }

  // SPA route → index.html (never cached, so new deploys show up immediately).
  return serveFile(path.join(SITE, 'index.html'), 'no-cache');
};
