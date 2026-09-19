// Own-message match rule: Beeper truncates long messages in its HTML
// rendering, so an exact match fails for long replies. Compare only the
// first 200 characters of both sides (capped at the shorter one) — a
// truncated copy still matches, and a short unrelated message can't collide.
import { canonicalize } from '../Text/canonicalize.js';

const OWN_PREFIX_CHARS = 200;
const MIN_MATCH_CHARS = 1;

export function isOwnMessage(sentText: string, receivedText: string): boolean {
  const sent = canonicalize(sentText);
  const received = canonicalize(receivedText);
  if (!sent || !received) return false;
  const n = Math.min(OWN_PREFIX_CHARS, sent.length, received.length);
  if (n < MIN_MATCH_CHARS) return false;
  return sent.slice(0, n) === received.slice(0, n);
}
