import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeeperMcpAdapter, MCP_TIMEOUT_MS } from '../../../src/Infrastructure/Beeper/BeeperMcpAdapter.js';

// Stubs the MCP server: responds to any tools/call with the given items as
// an SSE-framed JSON-RPC result.
function stubMcpServer(items: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        `data: ${JSON.stringify({
          result: {
            content: [{ type: 'text', text: JSON.stringify({ items }) }],
          },
        })}\n\n`,
        { status: 200 },
      ),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

function adapter(): BeeperMcpAdapter {
  return new BeeperMcpAdapter('http://localhost', 'token');
}

describe('BeeperMcpAdapter', () => {
  describe('listMessages', () => {
    it('maps a text message onto ChatMessageData', async () => {
      stubMcpServer([{ id: 'm1', text: 'hello' }]);

      const messages = await adapter().listMessages('9130', 20);

      expect(messages).toEqual([{ id: 'm1', text: 'hello' }]);
    });

    it('drops whitespace-only text', async () => {
      stubMcpServer([{ id: 'm1', text: '   ' }]);

      const messages = await adapter().listMessages('9130', 20);

      expect(messages).toEqual([{ id: 'm1' }]);
    });

    it('drops a message without text', async () => {
      stubMcpServer([{ id: 'm1' }]);

      const messages = await adapter().listMessages('9130', 20);

      expect(messages).toEqual([{ id: 'm1' }]);
    });

    it('maps only audio attachments', async () => {
      stubMcpServer([
        {
          id: 'm1',
          attachments: [
            { id: 'a1', type: 'audio', fileName: 'voice.ogg', srcURL: 'mxc://x' },
            { id: 'a2', type: 'file', fileName: 'doc.pdf' },
          ],
        },
      ]);

      const messages = await adapter().listMessages('9130', 20);

      expect(messages).toEqual([
        {
          id: 'm1',
          attachments: [
            { id: 'a1', fileName: 'voice.ogg', srcURL: 'mxc://x' },
          ],
        },
      ]);
    });

    it('maps senderID and isSender when present', async () => {
      stubMcpServer([
        { id: 'm1', text: 'hi', senderID: '@me:beeper.com', isSender: true },
      ]);

      const messages = await adapter().listMessages('9130', 20);

      expect(messages).toEqual([
        { id: 'm1', text: 'hi', senderID: '@me:beeper.com', isSender: true },
      ]);
    });

    it('omits senderID and isSender when absent', async () => {
      stubMcpServer([{ id: 'm1', text: 'hi' }]);

      const messages = await adapter().listMessages('9130', 20);

      expect(messages).toEqual([{ id: 'm1', text: 'hi' }]);
    });
  });

  describe('call timeout', () => {
    it('passes an AbortSignal timeout to the MCP fetch', async () => {
      let captured: AbortSignal | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          captured = init?.signal as AbortSignal;
          return new Response(
            `data: ${JSON.stringify({
              result: {
                content: [{ type: 'text', text: JSON.stringify({ items: [] }) }],
              },
            })}\n\n`,
            { status: 200 },
          );
        }),
      );

      const messages = await adapter().listMessages('9130', 20);

      expect(messages).toEqual([]);
      expect(captured).toBeInstanceOf(AbortSignal);
      expect(captured?.aborted).toBe(false);
      expect(MCP_TIMEOUT_MS).toBeGreaterThan(0);
    });
  });
});
