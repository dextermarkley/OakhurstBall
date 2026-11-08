// Chat reaction emoji: validation and the attribute name each one is stored under.
// Pure (no AWS imports), so unit tests can load it.
export const RX = 'rx_';
export const reactionAttr = (emoji: string) => RX + Buffer.from(emoji, 'utf8').toString('hex');
export const attrEmoji = (attr: string) => Buffer.from(attr.slice(RX.length), 'hex').toString('utf8');

/**
 * One emoji, or null: a single grapheme (so flags, skin tones and ZWJ families
 * count as one), made only of emoji code points.
 */
export function cleanEmoji(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > 32) return null;
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(v)];
  if (graphemes.length !== 1) return null;
  const ok = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[#*0-9\u200d\ufe0f\u20e3\u{E0020}-\u{E007F}])+$/u;
  if (!ok.test(v)) return null;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(v)) return null; // not just digits or joiners
  return v;
}
