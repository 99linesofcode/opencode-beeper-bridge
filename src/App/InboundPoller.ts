// Driving side: polls the chat for new messages and turns each into an
// action invocation — text messages are injected into the session, voice
// notes are relayed (transcribe → show → inject). Tracks a last-seen cursor
// so each message is handled exactly once; skips the bridge's own posts by
// their recorded ID.
import type { ChatPort } from '../Domain/Ports/ChatPort.js';
import type { ChatMessageData } from '../Domain/DataTransferObjects/ChatMessageData.js';
import type { LoggerPort } from '../Domain/Ports/LoggerPort.js';
import type { OwnMessageRegistry } from '../Domain/OwnMessageRegistry.js';
import type { Mutex } from '../Domain/Mutex.js';
import type { InjectMessageAction } from '../Domain/Actions/InjectMessageAction.js';
import type { RelayVoiceNoteAction } from '../Domain/Actions/RelayVoiceNoteAction.js';

export type InboundPollerOptions = {
  chatID: string;
  pollIntervalMs: number;
  messageLimit: number;
  sessionRef: { id: string | null };
  fallbackSessionID: string;
};

export class InboundPoller {
  private lastSeenID: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly chat: ChatPort,
    private readonly injectMessage: InjectMessageAction,
    private readonly relayVoiceNote: RelayVoiceNoteAction,
    private readonly registry: OwnMessageRegistry,
    private readonly mutex: Mutex,
    private readonly logger: LoggerPort,
    private readonly options: InboundPollerOptions,
  ) {}

  start(): void {
    // Seed the cursor from the newest message so history is not replayed.
    // The first poll must wait for the seed to resolve, otherwise lastSeenID
    // is null and the entire chat history gets injected.
    void this.chat
      .listMessages(this.options.chatID, this.options.messageLimit)
      .then((messages) => {
        const newest = messages[0];
        if (newest) this.lastSeenID = newest.id;
        this.logger.info(`seeded cursor at ${this.lastSeenID ?? 'none'}`);
      })
      .catch((err) => this.logger.error(`seed error: ${err}`))
      .finally(() => {
        this.timer = setInterval(
          () => void this.poll(),
          this.options.pollIntervalMs,
        );
      });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.mutex.run(async () => {
        const messages = await this.chat.listMessages(
          this.options.chatID,
          this.options.messageLimit,
        );
        // Newest-first; walk backwards to oldest, handle in chronological
        // order. Skip the bridge's own posts by recorded ID.
        const newMessages: ChatMessageData[] = [];
        for (const message of messages) {
          if (this.registry.isOwn(message.id)) continue;
          if (this.lastSeenID !== null && message.id === this.lastSeenID) break;
          newMessages.unshift(message);
        }
        const newest = newMessages[newMessages.length - 1];
        if (newest) this.lastSeenID = newest.id;

        for (const message of newMessages) {
          await this.handle(message);
        }
      });
    } catch (err) {
      this.logger.error(`poll error: ${err}`);
    } finally {
      this.polling = false;
    }
  }

  private async handle(message: ChatMessageData): Promise<void> {
    const sessionID = this.sessionID();
    if (!sessionID) {
      this.logger.info('no active session; skipping injection');
      return;
    }
    if (message.text) {
      await this.injectMessage.execute({ sessionID, text: message.text });
      this.logger.info(
        `injected message ${message.id} into session ${sessionID}`,
      );
      return;
    }
    const attachment = message.attachments?.[0];
    if (attachment) {
      await this.relayVoiceNote.execute({ sessionID, attachment });
      this.logger.info(`relayed voice note ${message.id}`);
    }
  }

  // The session ID is explicit in the config; the subscription loop sets
  // sessionRef at startup — this is the race fallback until then.
  private sessionID(): string | null {
    return this.options.sessionRef.id ?? this.options.fallbackSessionID;
  }
}
