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

// Content-Security-Policy: scripts only from this site; the browser may talk to
// this site, Cognito (sign-in) and the chat-photo bucket (uploads, images).
// Stripe Checkout is a full-page redirect, so it needs no entry here.
const region = process.env.AWS_REGION ?? 'us-west-2';
const bucket = process.env.CHAT_BUCKET;
const s3Hosts = bucket
  ? `https://${bucket}.s3.${region}.amazonaws.com https://${bucket}.s3.amazonaws.com https://s3.${region}.amazonaws.com`
  : '';
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // UI library injects <style> tags
  `img-src 'self' data: blob: ${s3Hosts}`.trim(),
  "font-src 'self' data:",
  `connect-src 'self' https://cognito-idp.${region}.amazonaws.com https://cognito-identity.${region}.amazonaws.com ${s3Hosts}`.trim(),
  "media-src 'self' blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  // Camera for the kiosk's QR pairing scanner; nothing else.
  'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
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

const notFound = (): APIGatewayProxyResultV2 => ({
  statusCode: 404,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...SECURITY_HEADERS },
  body: 'Not found',
});

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let raw: string;
  try {
    raw = decodeURIComponent(event.rawPath || '/');
  } catch {
    return notFound(); // malformed %-escape
  }

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
    return notFound();
  }

  // SPA route → index.html (never cached, so new deploys show up immediately).
  return serveFile(path.join(SITE, 'index.html'), 'no-cache');
};
