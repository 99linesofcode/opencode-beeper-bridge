// The core's need for the chat: send messages and read recent messages as
// identity + plain text. Designed for the core, never mimicking Beeper's
// API. The real adapter lives in Infrastructure.
import type { ChatMessageData } from '../DataTransferObjects/ChatMessageData.js';

export interface ChatPort {
  sendMessage(chatID: string, text: string): Promise<void>;
  listMessages(chatID: string, limit: number): Promise<ChatMessageData[]>;
}
