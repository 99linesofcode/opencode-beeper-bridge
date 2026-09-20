// Driving side: watches the session's event stream for assistant output and
// publishes one condensed message per completed turn. Turn detection: track
// message roles from message.updated; accumulate assistant text parts from
// message.part.updated (full part.text, keyed by partID — idempotent). This
// opencode version does NOT emit session.idle, so a turn is complete when no
// part arrives within a debounce window AND no tracked tool is still
// running — a tool phase must never flush the turn mid-flight, or only the
// text before the first tool call would reach the chat.
import type { SessionEvent, SessionPort } from '../Domain/Ports/SessionPort.js';
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

// Any part the stream can carry — tool parts carry no text but signal that
// the turn is still in flight.
type AnyPart = {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  state?: { status?: string };
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
    private readonly session: SessionPort,
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
          if (this.parts.has(textPart.id)) break; // duplicate; don't re-arm
          this.parts.set(textPart.id, {
            messageID: textPart.messageID,
            text: textPart.text,
          });
          this.turnMessageIDs.add(textPart.messageID);
        }

        // Any part — text or tool — means the turn is still moving. Arm on
        // everything so a tool phase postpones the flush.
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
    this.debounceTimer = setTimeout(
      () => void this.flushTurn(),
      TURN_DEBOUNCE_MS,
    );
  }

  private async flushTurn(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.parts.size === 0 && this.turnMessageIDs.size === 0) return;
    const sessionID = this.sessionRef.id;
    const messageIDs = [...this.turnMessageIDs];
    if (!sessionID || messageIDs.length === 0) return;

    // A tool still running means the turn is mid-flight — hold the flush
    // (and keep holding while the tool phase lasts) so the whole turn
    // publishes as one message instead of a fragment.
    if (await this.turnIsRunning(sessionID, messageIDs)) {
      this.armDebounce();
      return;
    }

    // NOTE: roles are NOT pruned. A single assistant message can span
    // multiple debounce windows (tool calls create gaps), and its later text
    // parts must still pass the role check. The map is bounded by the number
    // of messages in the session, so it stays small.
    const fallbackText = [...this.parts.values()]
      .map((p) => p.text)
      .join('\n');
    this.parts.clear();
    try {
      await this.publishTurn.execute({ sessionID, messageIDs, fallbackText });
      for (const id of messageIDs) this.sentMessageIDs.add(id);
      this.turnMessageIDs.clear();
      this.logger.info('published turn');
    } catch (err) {
      this.logger.error(`publish turn error: ${err}`);
    }
  }

  // A tracked message is still running when any of its parts is a tool in
  // the running state. A fetch failure counts as settled — the fallback text
  // path covers the content.
  private async turnIsRunning(
    sessionID: string,
    messageIDs: string[],
  ): Promise<boolean> {
    for (const messageID of messageIDs) {
      try {
        const message = (await this.session.getMessage(
          sessionID,
          messageID,
        )) as { parts?: Array<{ type?: string; state?: { status?: string } }> };
        const running = (message?.parts ?? []).some(
          (p) => p.type === 'tool' && p.state?.status === 'running',
        );
        if (running) return true;
      } catch (err) {
        this.logger.error(`turn state fetch error: ${err}`);
      }
    }
    return false;
  }
}
