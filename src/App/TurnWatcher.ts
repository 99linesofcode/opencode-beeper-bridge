// Driving side: watches the session's event stream for assistant output and
// publishes one condensed message per completed turn. Turn detection: track
// message roles from message.updated; accumulate assistant text parts from
// message.part.updated (full part.text, keyed by partID — idempotent). This
// opencode version does NOT emit session.idle, so a turn is complete when no
// new assistant text part arrives within a debounce window.
import type { SessionEvent } from '../Domain/Ports/SessionPort.js';
import type { LoggerPort } from '../Domain/Ports/LoggerPort.js';
import type { PublishTurnAction } from '../Domain/Actions/PublishTurnAction.js';

const TURN_DEBOUNCE_MS = 2000;

type TextPart = {
  id: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
};

export class TurnWatcher {
  private readonly roles = new Map<string, 'user' | 'assistant'>();
  private readonly parts = new Map<string, { messageID: string; text: string }>();
  // Assistant message IDs seen in this turn. SSE parts can be corrupted or
  // dropped (garbled events), so the authoritative text is fetched per
  // message on flush; these IDs say which messages to fetch.
  private readonly turnMessageIDs = new Set<string>();
  // Message IDs already published. Duplicate part events arrive after a
  // flush (the SSE stream repeats part updates); without this, a late
  // duplicate re-adds the part and re-arms the debounce → double send.
  private readonly sentMessageIDs = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly publishTurn: PublishTurnAction,
    private readonly logger: LoggerPort,
    private readonly sessionRef: { id: string | null },
  ) {}

  handleEvent(event: SessionEvent): void {
    this.logger.debug(
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
          this.roles.set(info.id, info.role);
        }
        break;
      }
      case 'message.part.updated': {
        const part = (event.data as { properties?: { part?: TextPart } })
          .properties?.part;
        if (!part || part.type !== 'text' || part.synthetic || part.ignored)
          break;
        const role = this.roles.get(part.messageID);
        if (role !== 'assistant') break;
        if (this.sentMessageIDs.has(part.messageID)) break;
        if (this.parts.has(part.id)) break; // duplicate part event; don't re-arm
        this.parts.set(part.id, { messageID: part.messageID, text: part.text });
        this.turnMessageIDs.add(part.messageID);
        this.armDebounce();
        break;
      }
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private armDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushTurn(), TURN_DEBOUNCE_MS);
  }

  private async flushTurn(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.parts.size === 0 && this.turnMessageIDs.size === 0) return;
    // NOTE: roles are NOT pruned here. A single assistant message can span
    // multiple debounce windows (tool calls create gaps), and its later text
    // parts must still pass the role check. The map is bounded by the number
    // of messages in the session, so it stays small.
    const fallbackText = [...this.parts.values()]
      .map((p) => p.text)
      .join('\n');
    this.parts.clear();
    const sessionID = this.sessionRef.id;
    const messageIDs = [...this.turnMessageIDs];
    if (!sessionID || messageIDs.length === 0) return;
    try {
      await this.publishTurn.execute({ sessionID, messageIDs, fallbackText });
      for (const id of messageIDs) this.sentMessageIDs.add(id);
      this.turnMessageIDs.clear();
      this.logger.info('published turn');
    } catch (err) {
      this.logger.error(`publish turn error: ${err}`);
    }
  }
}
