// Driving side: watches the session's event stream for assistant output and
// posts each assistant text part to the chat as it is produced, so the user
// sees live progress during a long-running task instead of one condensed
// summary at the end. A streaming text part updates its text over several
// events, so each part is debounced briefly and posted once with its complete
// text. The turn-completion signal (session idle) is kept only as a safety
// net to flush any part still streaming when the turn ends.
import type { SessionEvent } from '../Domain/Ports/SessionPort.js';
import type { LoggerPort } from '../Domain/Ports/LoggerPort.js';
import type { PostToChatAction } from '../Domain/Actions/PostToChatAction.js';
import { canonicalize } from '../Domain/Text/canonicalize.js';

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

const PART_DEBOUNCE_MS = 400;
// Bound the dedup set — the service runs for days, and unbounded growth is a
// slow leak. Oldest evicted FIFO.
const MAX_SENT_TEXTS = 200;

export class TurnWatcher {
  private readonly roles = new Map<string, 'user' | 'assistant'>();
  private readonly parts = new Map<string, { messageID: string; text: string }>();
  // Canonicalized texts already posted. Dedup by content, not part ID: the
  // same assistant text can arrive under different part IDs (duplicate SSE
  // events, or a message re-emitted), and posting it twice is a duplicate.
  // A Map (not a Set) so insertion order drives FIFO eviction.
  private readonly sentTexts = new Map<string, boolean>();
  private readonly debounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  // Re-entrancy guard: opencode emits session.status(idle) AND session.idle
  // back-to-back on completion — the second must not re-enter while the
  // first flush is still posting.
  private flushing = false;

  constructor(
    private readonly postToChat: PostToChatAction,
    private readonly logger: LoggerPort,
    private readonly sessionRef: { id: string | null },
    private readonly debounceMs: number = PART_DEBOUNCE_MS,
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
          // Store the latest text and (re)schedule the post — a streaming
          // part updates its text over several events, so debounce until it
          // stops changing, then post the complete text once. Dedup happens
          // at post time by canonicalized content.
          this.parts.set(textPart.id, {
            messageID: textPart.messageID,
            text: textPart.text,
          });
          this.schedulePost(textPart.id);
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
          void this.flushPending();
        }
        break;
      }
      case 'session.idle': {
        // Belt and braces: some versions emit the dedicated idle event.
        void this.flushPending();
        break;
      }
    }
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  // Observability for tests: how many distinct texts are currently deduped.
  get sentTextsSize(): number {
    return this.sentTexts.size;
  }

  // Observability for tests: how many parts are still awaiting a post.
  get partsSize(): number {
    return this.parts.size;
  }

  private schedulePost(partID: string): void {
    const existing = this.debounceTimers.get(partID);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(partID);
      void this.postPart(partID);
    }, this.debounceMs);
    this.debounceTimers.set(partID, timer);
  }

  private async postPart(partID: string): Promise<void> {
    const part = this.parts.get(partID);
    if (!part) return;
    const text = part.text?.trim();
    if (!text) return;
    const key = canonicalize(text);
    if (this.sentTexts.has(key)) {
      // Already posted — the part is redundant; drop it.
      this.parts.delete(partID);
      return;
    }
    // Mark BEFORE the await: two parts with the same text can fire their
    // debounce timers concurrently, and a check-then-add-after-await lets
    // both pass and double-post. Marking first closes the race.
    this.markSent(key);
    try {
      await this.postToChat.execute(text);
    } catch (err) {
      this.logger.error(`post part error: ${err}`);
    } finally {
      // Posted parts need not stay; flushPending only needs not-yet-posted
      // parts.
      this.parts.delete(partID);
    }
  }

  private markSent(key: string): void {
    this.sentTexts.set(key, true);
    if (this.sentTexts.size > MAX_SENT_TEXTS) {
      const oldest = this.sentTexts.keys().next().value;
      if (oldest !== undefined) this.sentTexts.delete(oldest);
    }
  }

  // Safety net: when the turn ends, post any part still streaming (its
  // debounce hadn't fired yet). Idempotent via sentTexts.
  private async flushPending(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const partID of [...this.parts.keys()]) {
        await this.postPart(partID);
      }
    } finally {
      this.flushing = false;
    }
  }
}
