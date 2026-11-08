// Tiny HTTP helpers for API Gateway v2 (HTTP API) Lambda proxy responses.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// The site and the API share one origin, so browsers never need CORS. Allow only
// the site's own origin anyway, and keep API responses out of caches.
const CORS = {
  'content-type': 'application/json',
  'access-control-allow-origin': process.env.APP_BASE_URL || 'null',
  'access-control-allow-headers': 'content-type,authorization,x-kiosk-token,x-kiosk-device',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  vary: 'origin',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

export const ok = (body: unknown) => json(200, body);
export const created = (body: unknown) => json(201, body);
export const badRequest = (msg: string) => json(400, { error: msg });
export const unauthorized = (msg = 'unauthorized') => json(401, { error: msg });
export const forbidden = (msg = 'You don’t have access to this') => json(403, { error: msg });
export const notFound = (msg = 'Not found') => json(404, { error: msg });
export const serverError = (msg = 'Something went wrong. Please try again.') => json(500, { error: msg });

export function parseBody<T = any>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    const v = JSON.parse(raw);
    // Only a JSON object is a valid body; anything else reads as empty, so the
    // route's own checks answer with a 400.
    return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;
  } catch {
    return {} as T;
  }
}

/** Cognito JWT claims injected by the HTTP API JWT authorizer. */
export interface Claims {
  sub: string;
  email?: string;
  name?: string;
  /** Cognito has verified the email above (false right after an unverified change). */
  emailVerified: boolean;
  groups: string[]; // from cognito:groups
}

export function getClaims(event: APIGatewayProxyEventV2): Claims | null {
  const jwt = (event.requestContext as any)?.authorizer?.jwt;
  if (!jwt?.claims) return null;
  const c = jwt.claims;
  const rawGroups = c['cognito:groups'];
  const groups = Array.isArray(rawGroups)
    ? rawGroups
    : typeof rawGroups === 'string'
      ? rawGroups.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean)
      : [];
  const emailVerified = c.email_verified === true || c.email_verified === 'true';
  return { sub: c.sub, email: c.email, name: c.name, emailVerified, groups };
}

export const isAdmin = (claims: Claims | null) => !!claims?.groups.includes('admin');

/** Strip a leading stage/prefix so routing works on the raw path. */
export function routePath(event: APIGatewayProxyEventV2): string {
  return event.requestContext?.http?.path ?? event.rawPath ?? '/';
}

export const method = (event: APIGatewayProxyEventV2): string =>
  event.requestContext?.http?.method ?? 'GET';
