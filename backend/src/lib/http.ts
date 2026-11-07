// Tiny HTTP helpers for API Gateway v2 (HTTP API) Lambda proxy responses.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const CORS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization,x-kiosk-token',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

export const ok = (body: unknown) => json(200, body);
export const created = (body: unknown) => json(201, body);
export const badRequest = (msg: string) => json(400, { error: msg });
export const unauthorized = (msg = 'unauthorized') => json(401, { error: msg });
export const forbidden = (msg = 'forbidden') => json(403, { error: msg });
export const notFound = (msg = 'not found') => json(404, { error: msg });
export const serverError = (msg = 'internal error') => json(500, { error: msg });

export function parseBody<T = any>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  return JSON.parse(raw) as T;
}

/** Cognito JWT claims injected by the HTTP API JWT authorizer. */
export interface Claims {
  sub: string;
  email?: string;
  name?: string;
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
  return { sub: c.sub, email: c.email, name: c.name, groups };
}

export const isAdmin = (claims: Claims | null) => !!claims?.groups.includes('admin');

/** Strip a leading stage/prefix so routing works on the raw path. */
export function routePath(event: APIGatewayProxyEventV2): string {
  return event.requestContext?.http?.path ?? event.rawPath ?? '/';
}

export const method = (event: APIGatewayProxyEventV2): string =>
  event.requestContext?.http?.method ?? 'GET';
