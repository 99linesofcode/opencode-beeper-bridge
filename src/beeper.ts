// Beeper MCP client.
//
// Single responsibility: talk to the Beeper desktop app's local MCP server
// (JSON-RPC 2.0 over HTTP, Bearer auth). The bridge's only knowledge of
// Beeper lives here.

import { createSseParser } from './sse.js';
import { type Config } from './config.js';

export type BeeperAttachment = {
  id: string;
  type?: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  isVoiceNote?: boolean;
  srcURL?: string;
};

export type BeeperMessage = {
  id: string;
  text?: string;
  timestamp?: string;
  isSender?: boolean;
  type?: string;
  attachments?: BeeperAttachment[];
  [key: string]: unknown;
};

export type BeeperClient = {
  sendMessage(chatID: string, text: string): Promise<string>;
  listMessages(chatID: string, limit?: number): Promise<BeeperMessage[]>;
};

// Extract the plain text of a Beeper message, if any.
export function extractText(message: BeeperMessage): string | undefined {
  const text = message.text;
  if (typeof text === 'string' && text.trim()) return text;
  return undefined;
}

type McpPayload = {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { message?: string };
};

export function createBeeperClient(config: Config): BeeperClient {
  const url = new URL(config.beeperMcpUrl);
  let requestId = 0;

  async function call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.beeperToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });
    if (!res.ok) throw new Error(`MCP ${tool} failed: HTTP ${res.status}`);

    // The MCP server responds as a single SSE message.
    const text = await res.text();
    let payload: McpPayload | undefined;
    const parser = createSseParser((event) => {
      payload = event.data as McpPayload;
    });
    parser.feed(text);

    if (!payload) throw new Error(`MCP ${tool}: empty response`);
    if (payload.error) throw new Error(`MCP ${tool}: ${payload.error.message}`);

    // Tool results arrive as JSON text in content[0].text.
    const content = payload.result?.content?.[0]?.text;
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  return {
    async sendMessage(chatID, text) {
      const result = await call('send_message', { chatID, text });
      // The MCP server returns a deeplink string like "**Open the chat in
      // Beeper**: /open/5000" — unique per send, usable as the message ID.
      if (typeof result !== 'string' || !result) {
        throw new Error(
          `MCP send_message: unexpected result ${JSON.stringify(result)}`,
        );
      }
      return result;
    },

    async listMessages(chatID, limit) {
      const args: Record<string, unknown> = { chatID };
      if (limit !== undefined) args.limit = limit;
      const result = await call('list_messages', args);
      const messages = (result as { items?: BeeperMessage[] } | undefined)
        ?.items;
      if (!messages)
        throw new Error(
          `MCP list_messages: no items in ${JSON.stringify(result)}`,
        );
      return messages;
    },
  };
}
