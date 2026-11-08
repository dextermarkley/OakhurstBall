// Liability waiver + club rules that every player signs before using the app.
//
// The text lives here (served to the app by GET /api/me/agreements) so what a
// player saw is exactly what was recorded. Changing either document means
// bumping its version: everyone is then asked to sign/acknowledge again.
//
// Each signature is its own immutable record, with a hash of the exact text:
//   PK=PLAYER#<id>  SK=AGREEMENT#<kind>#<version>
//     { signedName, adult, guardianName?, at, ip, userAgent, textSha256 }
// and the player profile gets waiverVersion / rulesVersion / agreedAt for quick checks.
//
// NOTE: the waiver is a common, plain-language template, not legal advice. Have
// it reviewed for your state before relying on it.
import { createHash } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, keys } from './ddb.js';

export interface Doc {
  kind: 'waiver' | 'rules';
  version: string;
  title: string;
  intro: string;
  sections: Array<{ heading?: string; body: string }>;
}

export const WAIVER: Doc = {
  kind: 'waiver',
  version: '2026-11-07',
  title: 'Release of Liability, Waiver of Claims, and Assumption of Risk',
  intro:
    'Please read this carefully. By signing, you give up certain legal rights, including the right to sue Oakhurst Basketball and the people who run it.',
  sections: [
    {
      heading: '1. The activity',
      body:
        'Oakhurst Basketball (“the Club”) organizes informal, recreational pickup basketball. The Club is a volunteer-run group, not a professional organization. There are no referees, coaches, trainers or medical staff on site.',
    },
    {
      heading: '2. I understand the risks',
      body:
        'Basketball is a physical, competitive sport. I understand that taking part can lead to injury, including sprains, strains, broken bones, concussions, dental injuries, eye injuries, heart problems, paralysis and, rarely, death. Injuries can be caused by my own actions, by other players, by the ball, by the floor, walls, hoops or other equipment, by the condition of the facility, or by the negligence of others. I voluntarily accept all of these risks, known and unknown.',
    },
    {
      heading: '3. I am fit to play',
      body:
        'I confirm that I am in good enough health to play basketball and that I know of no medical condition that makes it unsafe for me. I am responsible for consulting a doctor if I am unsure. I will stop playing if I feel unwell, dizzy or hurt.',
    },
    {
      heading: '4. Release and waiver',
      body:
        'To the fullest extent the law allows, I release and agree not to sue the Club, its organizers, admins, volunteers, members, and the owners and operators of the facilities we use (together, “the Released Parties”) for any injury, illness, death, loss or damage that arises out of my participation, including claims based on the Released Parties’ ordinary negligence. This release does not cover gross negligence or intentional misconduct.',
    },
    {
      heading: '5. Indemnity',
      body:
        'I agree to cover the costs, including reasonable legal fees, of any claim brought against the Released Parties because of my own conduct, or brought by someone else on my behalf for my injuries.',
    },
    {
      heading: '6. Medical treatment',
      body:
        'If I am hurt and cannot consent myself, I authorize the Club’s organizers to call emergency services and to seek first aid or medical treatment for me. I am responsible for any resulting costs. I understand the Club does not carry medical or accident insurance for players, and I rely on my own health insurance.',
    },
    {
      heading: '7. Rules and conduct',
      body:
        'I will follow the Club rules and the facility’s rules, and play in a safe, respectful way. The Club may ask me to stop playing or leave, and may remove my membership, for unsafe or disrespectful behavior.',
    },
    {
      heading: '8. Personal property',
      body: 'The Club is not responsible for lost, stolen or damaged personal belongings.',
    },
    {
      heading: '9. Photos',
      body:
        'Photos or videos may be taken at sessions and shared in the Club chat or with members. If I don’t want to appear in them, I will tell an organizer.',
    },
    {
      heading: '10. Minors',
      body:
        'If the player is under 18, a parent or legal guardian must sign. The parent or guardian agrees to this waiver on the minor’s behalf and on their own behalf, and confirms the minor is fit to play.',
    },
    {
      heading: '11. The whole agreement',
      body:
        'This waiver applies to every session I attend until I withdraw it in writing. If any part of it is found unenforceable, the rest still applies. I have read it, I understand it, and I am signing it voluntarily. My typed name below is my electronic signature.',
    },
  ],
};

export const RULES: Doc = {
  kind: 'rules',
  // Bumped from 2026-11-07 when the rules were rewritten: everyone acknowledges again.
  version: '2026-11-07.2',
  title: 'Oakhurst Basketball Club Rules',
  intro: 'How we keep pickup fun, fair and safe.',
  sections: [
    { heading: 'Club Rules', body: '1. Check in and pay before you play.' },
    { heading: 'Club Rules', body: '2. No fighting. You will be asked to leave.' },
    { heading: 'Club Rules', body: '3. Call your own fouls, be respectful.' },
    { heading: 'Club Rules', body: '4. Shoot a 3 to settle disputes quickly.' },
    { heading: 'Club Rules', body: '5. Play hard, but do not injure others.' },
    { heading: 'Club Rules', body: '6. Do not leave water bottles or trash.' },
    { heading: 'Club Rules', body: '7. Minors must bring a legal guardian, coach, or have approval to play from an admin.' },
    { heading: 'Play Rules', body: '1. Shots count for 2 & 3.' },
    { heading: 'Play Rules', body: '2. Most games will be to 15.' },
    { heading: 'Play Rules', body: '3. Backcourt violations will be called.' },
    { heading: 'Play Rules', body: '4. You cannot catch your own airball.' },
  ],
};

export const docHash = (d: Doc) => createHash('sha256').update(JSON.stringify(d)).digest('hex');

export interface AgreementStatus {
  waiverVersion?: string;
  rulesVersion?: string;
  agreedAt?: string;
  signedName?: string;
}

export const isCurrent = (p: AgreementStatus | null | undefined) =>
  !!p && p.waiverVersion === WAIVER.version && p.rulesVersion === RULES.version;

/** Validate a signature from the API. */
export function checkSignature(b: any): { sig?: { signedName: string; adult: boolean; guardianName?: string }; error?: string } {
  if (b?.waiverVersion !== WAIVER.version || b?.rulesVersion !== RULES.version) {
    return { error: 'The waiver or rules changed. Reload the page and read the current version.' };
  }
  if (b?.agreeRules !== true) return { error: 'Check the box to confirm you’ve read the club rules' };
  if (b?.agreeWaiver !== true) return { error: 'Check the box to agree to the waiver' };
  const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const signedName = clean(b?.signedName);
  if (signedName.length < 3 || signedName.length > 100 || !/\s/.test(signedName)) {
    return { error: 'Type your full name (first and last) to sign' };
  }
  if (typeof b?.adult !== 'boolean') return { error: 'Tell us whether the player is 18 or older' };
  const guardianName = clean(b?.guardianName);
  if (!b.adult && (guardianName.length < 3 || guardianName.length > 100 || !/\s/.test(guardianName))) {
    return { error: 'A parent or guardian must type their full name to sign for a player under 18' };
  }
  return { sig: { signedName, adult: b.adult, guardianName: b.adult ? undefined : guardianName } };
}

/** Record both documents for a player, in one write. */
export async function recordAgreements(
  playerId: string,
  sig: { signedName: string; adult: boolean; guardianName?: string },
  ctx: { sub: string; ip?: string; userAgent?: string },
): Promise<string> {
  const at = new Date().toISOString();
  const rec = (d: Doc) => ({
    Put: {
      TableName: TABLE,
      Item: {
        PK: `PLAYER#${playerId}`,
        SK: `AGREEMENT#${d.kind}#${d.version}`,
        kind: d.kind,
        version: d.version,
        title: d.title,
        textSha256: docHash(d),
        ...sig,
        at,
        sub: ctx.sub,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 300),
      },
      // Signatures are never overwritten; signing the same version twice is a no-op below.
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  });
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          rec(WAIVER),
          rec(RULES),
          {
            Update: {
              TableName: TABLE,
              Key: keys.playerProfile(playerId),
              UpdateExpression: 'SET waiverVersion = :w, rulesVersion = :r, agreedAt = :at, signedName = :n, updatedAt = :at',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeValues: { ':w': WAIVER.version, ':r': RULES.version, ':at': at, ':n': sig.signedName },
            },
          },
        ],
      }),
    );
  } catch (err: any) {
    if (err?.name !== 'TransactionCanceledException') throw err;
    // Already signed this version (e.g. a double tap): keep the original record.
  }
  return at;
}
