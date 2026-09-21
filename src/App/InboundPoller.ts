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

const HANDLE_TIMEOUT_MS = 180_000;

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
      // List + advance the cursor under the mutex (fast), then release it
      // before handling so a slow/hung relay never blocks the next poll or
      // the outbound echo-guard.
      let newMessages: ChatMessageData[] = [];
      await this.mutex.run(async () => {
        const messages = await this.chat.listMessages(
          this.options.chatID,
          this.options.messageLimit,
        );
        // Newest-first; walk backwards to oldest, handle in chronological
        // order. Skip the bridge's own posts by recorded ID, and by
        // recently-sent text (covers the case where ID correlation failed).
        newMessages = [];
        for (const message of messages) {
          if (this.registry.isOwn(message.id)) continue;
          if (message.text !== undefined && this.registry.isOwnText(message.text)) continue;
          // Only the user's own account may drive the agent. isSender ===
          // false is an explicit "not from the authenticated account" — skip
          // it. Absent isSender is fail-open: a payload-shape change degrades
          // to today's behavior (inject) instead of deafening the bridge.
          if (message.isSender === false) {
            this.logger.info(
              `skipping message ${message.id} from ${message.senderID ?? 'unknown'} (not the user's own account)`,
            );
            continue;
          }
          if (this.lastSeenID !== null && message.id === this.lastSeenID) break;
          newMessages.unshift(message);
        }
        const newest = newMessages[newMessages.length - 1];
        if (newest) this.lastSeenID = newest.id;
      });

      // Handle outside the mutex and the polling guard. Text messages are
      // awaited (fast); voice relays run in the background so a slow or hung
      // transcription can never block text delivery or the next poll.
      for (const message of newMessages) {
        if (message.text) {
          await this.handleWithTimeout(message);
        } else if (message.attachments?.[0]) {
          void this.relayWithTimeout(message);
        }
      }
    } catch (err) {
      this.logger.error(`poll error: ${err}`);
    } finally {
      this.polling = false;
    }
  }

  // A hung handle (a fetch without a timeout, a stuck child process) would
  // hold the re-entrancy guard forever and deafen the bridge. Time each
  // message out so a hang degrades loudly instead of silently.
  private async handleWithTimeout(message: ChatMessageData): Promise<void> {
    await Promise.race([
      this.handle(message),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), HANDLE_TIMEOUT_MS).unref(),
      ),
    ]).then((result) => {
      if (result === 'timeout') {
        this.logger.error(
          `handle message ${message.id} timed out after ${HANDLE_TIMEOUT_MS}ms; skipping`,
        );
      }
    });
  }

  // Voice relays run in the background so they never block the poll loop.
  private async relayWithTimeout(message: ChatMessageData): Promise<void> {
    await Promise.race([
      this.relayVoiceNote.execute({
        sessionID: this.sessionID() ?? this.options.fallbackSessionID,
        attachment: message.attachments![0]!,
      }),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), HANDLE_TIMEOUT_MS).unref(),
      ),
    ]).then((result) => {
      if (result === 'timeout') {
        this.logger.error(
          `relay message ${message.id} timed out after ${HANDLE_TIMEOUT_MS}ms`,
        );
      } else {
        this.logger.info(`relayed voice note ${message.id}`);
      }
    });
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
    }
  }

  // The session ID is explicit in the config; the subscription loop sets
  // sessionRef at startup — this is the race fallback until then.
  private sessionID(): string | null {
    return this.options.sessionRef.id ?? this.options.fallbackSessionID;
  }
}
