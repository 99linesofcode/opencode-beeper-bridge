// Outbound SSE consumer.
//
// Single responsibility: watch the opencode SSE stream for assistant output
// and post one condensed markdown message to Beeper per completed turn.
//
// Turn detection: track message roles from `message.updated`; accumulate
// assistant text parts from `message.part.updated` (full part.text, keyed by
// partID — idempotent). This opencode version does NOT emit `session.idle`,
// so a turn is considered complete when no new assistant text part arrives
// within a debounce window — then condense + send + clear.
//
// Send + record-ID run under the shared lock so the inbound poller can never
// list a sent message before its ID is recorded as own.

import { type SSEEvent } from './sse.js';
import { type BeeperClient } from './beeper.js';
import { type OpencodeClient } from './socket.js';
import { type Config } from './config.js';
import { type Logger } from './log.js';
import { type SentRegistry } from './sent.js';
import { type Lock } from './lock.js';
import { createOwnMessageRecorder } from './own-message.js';
import { formatForBeeper } from './format.js';

export type OutboundConsumer = {
  handleEvent(event: SSEEvent): void;
  stop(): void;
};

type TextPart = {
  id: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
};

const TURN_DEBOUNCE_MS = 2000;

// Extract the concatenated text of a message fetched from the socket API.
// The message shape is { parts: [{ type: "text", text }] }.
function extractMessageText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const parts = (message as { parts?: Array<{ type?: string; text?: string }> })
    .parts;
  if (!Array.isArray(parts)) return undefined;
  const texts = parts
    .filter(
      (p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim(),
    )
    .map((p) => p.text as string);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

export function createOutboundConsumer(
  config: Config,
  beeper: BeeperClient,
  opencode: OpencodeClient,
  logger: Logger,
  registry: SentRegistry,
  lock: Lock,
  sessionRef: { id: string | null },
): OutboundConsumer {
  const roles = new Map<string, 'user' | 'assistant'>();
  const parts = new Map<string, { messageID: string; text: string }>();
  // Assistant message IDs seen in this turn. SSE parts can be corrupted or
  // dropped (garbled events), so the authoritative text is fetched from the
  // socket API on flush; these IDs say which messages to fetch.
  const turnMessageIDs = new Set<string>();
  // Message IDs already sent to Beeper. Duplicate part events arrive after a
  // flush (the SSE stream repeats part updates); without this, a late
  // duplicate re-adds the part and re-arms the debounce → double send.
  const sentMessageIDs = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const recordOwnMessage = createOwnMessageRecorder(
    beeper,
    config,
    registry,
    logger,
  );

  function handleEvent(event: SSEEvent): void {
    logger.debug(
      `event ${event.event}: ${JSON.stringify(event.data).slice(0, 120)}`,
    );
    switch (event.event) {
      case 'message.updated': {
        const info = (
          event.data as {
            properties?: { info?: { id?: string; role?: string } };
          }
        ).properties?.info;
        if (info?.id && (info.role === 'user' || info.role === 'assistant')) {
          roles.set(info.id, info.role);
        }
        break;
      }
      case 'message.part.updated': {
        const part = (event.data as { properties?: { part?: TextPart } })
          .properties?.part;
        if (!part || part.type !== 'text' || part.synthetic || part.ignored)
          break;
        const role = roles.get(part.messageID);
        if (role !== 'assistant') break;
        if (sentMessageIDs.has(part.messageID)) break;
        if (parts.has(part.id)) break; // duplicate part event; don't re-arm
        parts.set(part.id, { messageID: part.messageID, text: part.text });
        turnMessageIDs.add(part.messageID);
        armDebounce();
        break;
      }
    }
  }

  function stop(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function flushTurn(): Promise<void> {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (parts.size === 0 && turnMessageIDs.size === 0) return;
    // Order parts by insertion (Map preserves insertion order).
    let text = [...parts.values()].map((p) => p.text).join('\n');
    // SSE parts can be corrupted or dropped (garbled events), so fetch the
    // authoritative text from the socket API for each assistant message in
    // this turn. Fall back to the accumulated parts if a fetch fails.
    if (sessionRef.id && turnMessageIDs.size > 0) {
      const fetched = await fetchTurnText(sessionRef.id);
      if (fetched) text = fetched;
    }
    // NOTE: roles are NOT pruned here. A single assistant message can span
    // multiple debounce windows (tool calls create gaps), and its later text
    // parts must still pass the role check. The map is bounded by the number
    // of messages in the session, so it stays small.
    parts.clear();
    if (!text.trim()) return;
    try {
      await lock.run(async () => {
        const formatted = formatForBeeper(text);
        await beeper.sendMessage(config.beeperChatId, formatted);
        // Record the ID of the message we just sent so the inbound poller
        // skips it — otherwise the bridge re-injects its own replies as
        // prompts. Under the lock, so no poll can see it unrecorded.
        await recordOwnMessage(formatted);
        for (const id of turnMessageIDs) sentMessageIDs.add(id);
        turnMessageIDs.clear();
        logger.info(`sent turn to Beeper`);
      });
    } catch (err) {
      logger.error(`send to Beeper error: ${err}`);
    }
  }

  // Fetch the full text of every assistant message in this turn from the
  // socket API. Returns null if any fetch fails (caller falls back to the
  // accumulated SSE parts).
  async function fetchTurnText(sessionID: string): Promise<string | null> {
    const texts: string[] = [];
    for (const messageID of turnMessageIDs) {
      try {
        const message = await opencode.getMessage(sessionID, messageID);
        const messageText = extractMessageText(message);
        if (messageText) texts.push(messageText);
      } catch (err) {
        logger.error(`fetch message ${messageID} error: ${err}`);
        return null;
      }
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }

  // Arm the debounce: if no new assistant part arrives within the window,
  // the turn is complete — send.
  function armDebounce(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void flushTurn(), TURN_DEBOUNCE_MS);
  }

  return { handleEvent, stop };
}
