// Magic-link confirmation endpoint (public; the token in the path is the auth).
//
//   GET  /api/confirm/{token}          → payment details (for the confirm page to show)
//   POST /api/confirm/{token}  {action: 'confirm' | 'deny'}
// The emailed link itself points at /confirm/{token}, which is the SPA page (web Lambda).
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ok, badRequest, notFound, serverError, parseBody, routePath, method } from '../lib/http.js';
import { resolveToken, confirmPayment, denyPayment } from '../lib/payments.js';
import { getPlayer } from '../lib/repo.js';

function tokenFromPath(path: string): string | null {
  const m = path.match(/^\/api\/confirm\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const path = routePath(event);
    const m = method(event);
    if (m === 'OPTIONS') return ok({});

    const token = tokenFromPath(path);
    if (!token) return badRequest('missing token');

    if (m === 'GET') {
      const resolved = await resolveToken(token);
      if (!resolved) return notFound('This confirmation link is expired or already used.');
      const player = await getPlayer(resolved.playerId);
      return ok({
        status: resolved.payment.status,
        amountCents: resolved.payment.amountCents,
        method: resolved.payment.method,
        playerName: player?.name ?? 'player',
        note: resolved.payment.note,
        createdAt: resolved.payment.createdAt,
      });
    }

    if (m === 'POST') {
      const { action } = parseBody(event);
      if (action === 'confirm') {
        const r = await confirmPayment(token);
        if (r === 'gone') return notFound('Link expired or already used.');
        if (r === 'already') return ok({ result: 'already_handled' });
        return ok({ result: 'confirmed' });
      }
      if (action === 'deny') {
        const r = await denyPayment(token);
        if (r === 'gone') return notFound('Link expired or already used.');
        if (r === 'already') return ok({ result: 'already_handled' });
        return ok({ result: 'denied' });
      }
      return badRequest("action must be 'confirm' or 'deny'");
    }

    return notFound();
  } catch (err) {
    console.error('confirm error', err);
    return serverError();
  }
};
