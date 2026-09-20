// Driving side: watches the session's event stream for assistant output and
// publishes one condensed message per completed turn. The turn-completion
// signal is the session's own status: opencode emits session.status
// {"type":"idle"} (and session.idle) when a turn finishes — no debounce
// guessing, no mid-turn flushes. Text parts accumulate for the fallback;
// tool parts clear them (the fallback tracks only the closing section); the
// authoritative summary comes from the socket API at flush time.
import type { SessionEvent } from '../Domain/Ports/SessionPort.js';
import type { LoggerPort } from '../Domain/Ports/LoggerPort.js';
import type { PublishTurnAction } from '../Domain/Actions/PublishTurnAction.js';

type TextPart = {
  id: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
};

// Any part the stream can carry — tool parts carry no text but mark the
// boundary where intermediate commentary ends.
type AnyPart = {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
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
  // duplicate re-adds the part and a second idle would double-send.
  private readonly sentMessageIDs = new Set<string>();
  // Re-entrancy guard: opencode emits session.status(idle) AND session.idle
  // back-to-back on completion — the second must not re-enter while the
  // first flush is still marking messages as sent.
  private flushing = false;

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
        const part = (event.data as { properties?: { part?: AnyPart } })
          .properties?.part;
        if (!part || part.synthetic || part.ignored) break;
        const role = part.messageID
          ? this.roles.get(part.messageID)
          : undefined;

        if (part.type === 'text') {
          if (role !== 'assistant') break;
          const textPart = part as TextPart;
          if (this.sentMessageIDs.has(textPart.messageID)) break;
          if (this.parts.has(textPart.id)) break; // duplicate part event
          this.parts.set(textPart.id, {
            messageID: textPart.messageID,
            text: textPart.text,
          });
          this.turnMessageIDs.add(textPart.messageID);
        } else if (part.type === 'tool') {
          // A tool call means everything accumulated so far is intermediate
          // commentary — the fallback text tracks only the closing section.
          this.parts.clear();
        }
        break;
      }
      case 'session.status': {
        // The turn-completion signal: the session leaves the busy state.
        const status = (
          event.data as {
            properties?: {
              sessionID?: string;
              status?: { type?: string };
            };
          }
        ).properties;
        if (
          status?.sessionID === this.sessionRef.id &&
          status.status?.type === 'idle'
        ) {
          void this.flushTurn();
        }
        break;
      }
      case 'session.idle': {
        // Belt and braces: some versions emit the dedicated idle event.
        void this.flushTurn();
        break;
      }
    }
  }

  stop(): void {
    // No timers to stop — the idle event is the only flush trigger. Kept
    // for lifecycle symmetry with the inbound poller.
  }

  private async flushTurn(): Promise<void> {
    if (this.flushing) return;
    if (this.parts.size === 0 && this.turnMessageIDs.size === 0) return;
    this.flushing = true;
    try {
      const sessionID = this.sessionRef.id;
      const messageIDs = [...this.turnMessageIDs];
      if (!sessionID || messageIDs.length === 0) return;

      // NOTE: roles are NOT pruned. A single assistant message can span
      // multiple turns' worth of events (tool calls create gaps), and its
      // later text parts must still pass the role check. The map is bounded
      // by the number of messages in the session, so it stays small.
      const fallbackText = [...this.parts.values()]
        .map((p) => p.text)
        .join('\n');
      this.parts.clear();
      await this.publishTurn.execute({ sessionID, messageIDs, fallbackText });
      for (const id of messageIDs) this.sentMessageIDs.add(id);
      this.turnMessageIDs.clear();
      this.logger.info('published turn');
    } catch (err) {
      this.logger.error(`publish turn error: ${err}`);
    } finally {
      this.flushing = false;
    }
  }
}
