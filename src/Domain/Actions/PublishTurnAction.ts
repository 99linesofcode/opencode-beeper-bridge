// UC: a completed assistant turn reaches the chat as one condensed message.
// SSE parts can be corrupted or dropped, so the authoritative text is
// fetched from the session API per assistant message before posting.
import type { SessionPort } from '../Ports/SessionPort.js';
import type { LoggerPort } from '../Ports/LoggerPort.js';
import type { PostToChatAction } from './PostToChatAction.js';

export class PublishTurnAction {
  constructor(
    private readonly session: SessionPort,
    private readonly postToChat: PostToChatAction,
    private readonly logger: LoggerPort,
  ) {}

  async execute(input: {
    sessionID: string;
    messageIDs: string[];
    // The text accumulated from the stream — used when the authoritative
    // fetch fails, so a garbled event never loses the turn entirely.
    fallbackText?: string;
  }): Promise<void> {
    const fetched = await this.turnText(input.sessionID, input.messageIDs);
    const text = fetched ?? input.fallbackText;
    if (!text?.trim()) return;
    await this.postToChat.execute(text);
  }

  private async turnText(
    sessionID: string,
    messageIDs: string[],
  ): Promise<string | null> {
    const texts: string[] = [];
    for (const messageID of messageIDs) {
      try {
        const message = await this.session.getMessage(sessionID, messageID);
        const messageText = extractMessageText(message);
        if (messageText) texts.push(messageText);
      } catch (err) {
        this.logger.error(`fetch message ${messageID} error: ${err}`);
        return null;
      }
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
}

// The session message shape is { parts: [{ type: "text", text }] }.
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
