// Beeper adapter. Talks to the Beeper desktop app's local MCP server
// (JSON-RPC 2.0 over HTTP, Bearer auth) and maps its responses onto the
// core's shapes. The bridge's only knowledge of Beeper lives here.
import type { ChatPort } from '../../Domain/Ports/ChatPort.js';
import type { ChatMessageData } from '../../Domain/DataTransferObjects/ChatMessageData.js';
import type { AudioAttachmentData } from '../../Domain/DataTransferObjects/AudioAttachmentData.js';
import { SseParser } from '../Sse/SseParser.js';

// Provider shapes (Beeper MCP payloads) — never leave this file.
type BeeperMessage = {
  id: string;
  text?: string;
  attachments?: BeeperAttachment[];
  [key: string]: unknown;
};

type BeeperAttachment = {
  id: string;
  type?: string;
  mimeType?: string;
  fileName?: string;
  srcURL?: string;
  [key: string]: unknown;
};

type McpPayload = {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { message?: string };
};

export class BeeperMcpAdapter implements ChatPort {
  private readonly url: URL;
  private requestId = 0;

  constructor(
    beeperMcpUrl: string,
    private readonly beeperToken: string,
  ) {
    this.url = new URL(beeperMcpUrl);
  }

  async sendMessage(chatID: string, text: string): Promise<void> {
    // The MCP server returns a deeplink string, unique per send — unused:
    // own-message correlation goes through list_messages instead.
    await this.call('send_message', { chatID, text });
  }

  async listMessages(
    chatID: string,
    limit: number,
  ): Promise<ChatMessageData[]> {
    const result = await this.call('list_messages', { chatID, limit });
    const messages = (result as { items?: BeeperMessage[] } | undefined)
      ?.items;
    if (!messages) {
      throw new Error(
        `MCP list_messages: no items in ${JSON.stringify(result)}`,
      );
    }
    return messages.map(toChatMessageData);
  }

  private async call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.beeperToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.requestId,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });
    if (!res.ok) throw new Error(`MCP ${tool} failed: HTTP ${res.status}`);

    // The MCP server responds as a single SSE message.
    const text = await res.text();
    let payload: McpPayload | undefined;
    const parser = new SseParser((event) => {
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
}

function toChatMessageData(message: BeeperMessage): ChatMessageData {
  const data: ChatMessageData = { id: message.id };
  if (typeof message.text === 'string' && message.text.trim()) {
    data.text = message.text;
  }
  const attachments = (message.attachments ?? [])
    .filter(isAudio)
    .map(toAudioAttachmentData);
  if (attachments.length > 0) data.attachments = attachments;
  return data;
}

// Only audio attachments cross the boundary — the core's voice-note story
// has no use for other file kinds.
function isAudio(attachment: BeeperAttachment): boolean {
  return (
    attachment.type === 'audio' ||
    (attachment.mimeType?.startsWith('audio/') ?? false)
  );
}

function toAudioAttachmentData(
  attachment: BeeperAttachment,
): AudioAttachmentData {
  const data: AudioAttachmentData = { id: attachment.id };
  if (attachment.fileName !== undefined) data.fileName = attachment.fileName;
  if (attachment.srcURL !== undefined) data.srcURL = attachment.srcURL;
  return data;
}
