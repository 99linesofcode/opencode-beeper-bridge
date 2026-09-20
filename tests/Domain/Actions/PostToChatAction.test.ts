import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatPort } from '../../../src/Domain/Ports/ChatPort.js';
import type { ChatMessageData } from '../../../src/Domain/DataTransferObjects/ChatMessageData.js';
import type { LoggerPort } from '../../../src/Domain/Ports/LoggerPort.js';
import { OwnMessageRegistry } from '../../../src/Domain/OwnMessageRegistry.js';
import { Mutex } from '../../../src/Domain/Mutex.js';
import { PostToChatAction } from '../../../src/Domain/Actions/PostToChatAction.js';

const logger: LoggerPort = { info: () => {}, debug: () => {}, error: () => {} };

function fakeChat(messages: ChatMessageData[]): {
  chat: ChatPort;
  sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    chat: {
      async sendMessage(_chatID, text) {
        sent.push(text);
      },
      async listMessages() {
        return messages;
      },
    },
  };
}

function postToChat(chat: ChatPort, registry: OwnMessageRegistry) {
  return new PostToChatAction(chat, registry, new Mutex(), logger, '9130', 20);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PostToChatAction', () => {
  it('sends the formatted text and marks the matching message as own', async () => {
    const registry = new OwnMessageRegistry();
    const { chat, sent } = fakeChat([{ id: 'msg_1', text: 'hello from the bridge' }]);

    await postToChat(chat, registry).execute('hello from the bridge');

    expect(sent).toEqual(['hello from the bridge']);
    expect(registry.isOwn('msg_1')).toBe(true);
  });

  it('matches a truncated copy of a long message', async () => {
    // Beeper truncates long messages in its HTML rendering; the prefix
    // comparison must still correlate the truncated copy.
    const registry = new OwnMessageRegistry();
    const sentText = 'x'.repeat(300);
    const { chat } = fakeChat([{ id: 'msg_1', text: sentText.slice(0, 150) }]);

    await postToChat(chat, registry).execute(sentText);

    expect(registry.isOwn('msg_1')).toBe(true);
  });

  it('does not mark unrelated messages', async () => {
    vi.useFakeTimers();
    const registry = new OwnMessageRegistry();
    const { chat } = fakeChat([{ id: 'msg_1', text: 'completely unrelated' }]);

    const done = postToChat(chat, registry).execute('hello from the bridge');
    await vi.advanceTimersByTimeAsync(6000);
    await done;

    expect(registry.isOwn('msg_1')).toBe(false);
  });

  it('gives up after three attempts when the message never appears', async () => {
    vi.useFakeTimers();
    const registry = new OwnMessageRegistry();
    const { chat } = fakeChat([]);

    const done = postToChat(chat, registry).execute('hello');
    await vi.advanceTimersByTimeAsync(6000);
    await done;

    expect(registry.isOwn('msg_1')).toBe(false);
  });

  it('retries the send when the message never surfaces in the chat', async () => {
    vi.useFakeTimers();
    const registry = new OwnMessageRegistry();
    // The chat never shows the sent message — the send silently dropped.
    const { chat, sent } = fakeChat([]);
    const errors: string[] = [];
    const action = new PostToChatAction(
      chat,
      registry,
      new Mutex(),
      { info: () => {}, debug: () => {}, error: (m) => errors.push(m) },
      '9130',
      20,
    );

    const done = action.execute('hello');
    await vi.advanceTimersByTimeAsync(4000);
    await done;

    // The dropped send is retried once, and the failure is visible.
    expect(sent).toEqual(['hello', 'hello']);
    expect(errors.some((m) => m.includes('retrying'))).toBe(true);
  });

  it('does not retry when the message surfaces normally', async () => {
    vi.useFakeTimers();
    const registry = new OwnMessageRegistry();
    const { chat, sent } = fakeChat([
      { id: 'msg_1', text: 'hello from the bridge' },
    ]);

    await postToChat(chat, registry).execute('hello from the bridge');

    expect(sent).toEqual(['hello from the bridge']);
  });
});
