// Find the chat message that matches a just-sent message, by the own-message
// match rule. Returns its ID, or null when nothing matches.
import type { ChatMessageData } from '../DataTransferObjects/ChatMessageData.js';
import { isOwnMessage } from './isOwnMessage.js';

export function findOwnMessageID(
  messages: ChatMessageData[],
  sentText: string,
): string | null {
  for (const message of messages) {
    if (message.text === undefined) continue;
    if (isOwnMessage(sentText, message.text)) return message.id;
  }
  return null;
}
