// UC: a message reaches the chat as the bridge's own post, and its ID is
// recorded as own before any poll can list it — the echo-guard invariant.
// Send + correlate + mark run under the shared mutex.
import type { ChatPort } from '../Ports/ChatPort.js';
import type { LoggerPort } from '../Ports/LoggerPort.js';
import type { OwnMessageRegistry } from '../OwnMessageRegistry.js';
import type { Mutex } from '../Mutex.js';
import { formatForBeeper } from '../Text/formatForBeeper.js';
import { findOwnMessageID } from '../OwnMessages/findOwnMessageID.js';

export class PostToChatAction {
  constructor(
    private readonly chat: ChatPort,
    private readonly registry: OwnMessageRegistry,
    private readonly mutex: Mutex,
    private readonly logger: LoggerPort,
    private readonly chatID: string,
    private readonly messageLimit: number,
  ) {}

  async execute(text: string): Promise<void> {
    const formatted = formatForBeeper(text);
    await this.mutex.run(async () => {
      await this.chat.sendMessage(this.chatID, formatted);
      await this.recordOwn(formatted);
    });
  }

  // Correlate the just-sent message to its ID and mark it own. Retries
  // briefly to allow the message to propagate into list_messages.
  private async recordOwn(formatted: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const messages = await this.chat.listMessages(
          this.chatID,
          this.messageLimit,
        );
        const id = findOwnMessageID(messages, formatted);
        if (id !== null) {
          this.registry.markOwn(id);
          return;
        }
      } catch (err) {
        this.logger.error(`record own message error: ${err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
