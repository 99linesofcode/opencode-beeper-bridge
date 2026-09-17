// Own-message correlation.
//
// Single responsibility: after sending a message to Beeper, correlate it to
// its message ID and record it as own so the inbound poller never re-injects
// it. Shared by the outbound consumer (assistant turns) and the inbound
// handler (transcription posts).

import {
  type BeeperClient,
  type BeeperMessage,
  extractText,
} from './beeper.js';
import { type Config } from './config.js';
import { type Logger } from './log.js';
import { type SentRegistry } from './sent.js';
import { canonicalize } from './format.js';

// Beeper truncates long messages in its HTML rendering, so an exact match
// fails for long replies. Compare only the first OWN_PREFIX_CHARS of both
// sides (capped at the shorter one) — a truncated copy still matches, and a
// short unrelated message can't collide.
const OWN_PREFIX_CHARS = 200;
// Any non-empty match counts. Short replies ("single", "ok") must still be
// recognized as own; the prefix comparison already prevents false positives
// because a random short message won't share a prefix with what we sent.
const MIN_MATCH_CHARS = 1;

export type OwnMessageRecorder = (sentText: string) => Promise<void>;

// Create a recorder that finds the message ID of a just-sent message and
// marks it own. Retries briefly to allow the message to propagate into
// list_messages.
export function createOwnMessageRecorder(
  beeper: BeeperClient,
  config: Config,
  registry: SentRegistry,
  logger: Logger,
): OwnMessageRecorder {
  return async function recordOwnMessage(sentText: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const messages = await beeper.listMessages(
          config.beeperChatId,
          config.messageLimit,
        );
        const id = findMessageID(messages, sentText);
        if (id !== null) {
          registry.markOwn(id);
          return;
        }
      } catch (err) {
        logger.error(`record own message error: ${err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
}

function findMessageID(
  messages: BeeperMessage[],
  sentText: string,
): string | null {
  for (const message of messages) {
    const text = extractText(message);
    if (text === undefined) continue;
    if (isOwnMessage(sentText, text)) return message.id;
  }
  return null;
}

function isOwnMessage(sentText: string, receivedText: string): boolean {
  const sent = canonicalize(sentText);
  const received = canonicalize(receivedText);
  if (!sent || !received) return false;
  const n = Math.min(OWN_PREFIX_CHARS, sent.length, received.length);
  if (n < MIN_MATCH_CHARS) return false;
  return sent.slice(0, n) === received.slice(0, n);
}
