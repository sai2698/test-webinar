/**
 * Lightweight profanity masking for live chat.
 *
 * This is deliberately a *masking* filter, not a blocklist that rejects
 * messages: in a live webinar, silently dropping a message looks like a bug
 * to the sender. Masking keeps the conversation flowing while removing the
 * words a moderator would otherwise have to delete by hand.
 *
 * The list is intentionally short and conservative — it covers the words that
 * actually show up in abuse, not general profanity. Extend it per deployment.
 */

const WORDS = [
  'fuck',
  'fucking',
  'fucked',
  'shit',
  'shitty',
  'bullshit',
  'bitch',
  'bastard',
  'asshole',
  'dickhead',
  'cunt',
  'whore',
  'slut',
  'retard',
  'retarded',
  'nigger',
  'nigga',
  'faggot',
  'rape',
];

/**
 * Matches a blocked word even when the sender pads it with separators
 * (`f.u.c.k`, `f u c k`, `f-u-c-k`) or repeats a letter (`fuuuck`).
 */
const PATTERNS = WORDS.map((word) => {
  const letters = word.split('').map((c) => `${c}+`).join('[\\s._*\\-]*');
  return new RegExp(`\\b${letters}\\b`, 'gi');
});

/** Replaces the middle of a matched word with asterisks, keeping the first letter. */
function mask(match: string): string {
  if (match.length <= 2) return '*'.repeat(match.length);
  return match[0] + '*'.repeat(match.length - 1);
}

export function maskProfanity(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, mask);
  return out;
}

/** True when the text contained something that had to be masked. */
export function containsProfanity(text: string): boolean {
  return maskProfanity(text) !== text;
}
