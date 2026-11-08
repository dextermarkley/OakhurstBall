// Client-facing shapes of stored items. Allowlists, so a new attribute on a stored
// item (a token, a key, an internal flag) never reaches a browser by accident.
// Pure, no AWS imports, so unit tests can load it directly.

/** A payment as the paying player sees it. Never includes confirm tokens or table keys. */
export function paymentView(p: Record<string, any>) {
  return {
    paymentId: p.paymentId as string,
    amountCents: p.amountCents as number,
    method: p.method as string,
    status: p.status as string,
    plan: p.plan ?? null,
    periodLabel: p.periodLabel ?? null,
    createdAt: p.createdAt as string,
    settledAt: p.settledAt ?? null,
    note: p.note ?? null,
    creditedInstead: !!p.creditedInstead,
    reversed: p.reversed ?? null,
  };
}

/** Is this admin record the same person as this player? */
export function isSamePerson(
  player: { cognitoSub?: string; email?: string },
  admin: { cognitoSub?: string; email?: string },
): boolean {
  if (admin.cognitoSub && player.cognitoSub && admin.cognitoSub === player.cognitoSub) return true;
  return !!admin.email && !!player.email && admin.email.trim().toLowerCase() === player.email.trim().toLowerCase();
}
