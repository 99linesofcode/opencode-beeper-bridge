import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatPort } from '../../src/Domain/Ports/ChatPort.js';
import type { ChatMessageData } from '../../src/Domain/DataTransferObjects/ChatMessageData.js';
import type { LoggerPort } from '../../src/Domain/Ports/LoggerPort.js';
import type { InjectMessageAction } from '../../src/Domain/Actions/InjectMessageAction.js';
import type { RelayVoiceNoteAction } from '../../src/Domain/Actions/RelayVoiceNoteAction.js';
import { OwnMessageRegistry } from '../../src/Domain/OwnMessageRegistry.js';
import { Mutex } from '../../src/Domain/Mutex.js';
import { InboundPoller } from '../../src/App/InboundPoller.js';

function makePoller(
  messages: () => ChatMessageData[],
  log: string[],
): { poller: InboundPoller; injected: string[] } {
  // The seed call consumes the newest message to set the cursor, so the
  // first list returns nothing and later polls return the target.
  let calls = 0;
  const chat: ChatPort = {
    async listMessages() {
      calls += 1;
      return calls === 1 ? [] : messages();
    },
    async sendMessage() {},
  };
  const injected: string[] = [];
  const injectMessage = {
    execute: async (input: { sessionID: string; text: string }) => {
      injected.push(input.text);
    },
  } as unknown as InjectMessageAction;
  const relayVoiceNote = {
    execute: async () => {},
  } as unknown as RelayVoiceNoteAction;
  const logger: LoggerPort = {
    info: (m) => log.push(m),
    debug: () => {},
    error: () => {},
  };
  const poller = new InboundPoller(
    chat,
    injectMessage,
    relayVoiceNote,
    new OwnMessageRegistry(),
    new Mutex(),
    logger,
    {
      chatID: '9130',
      pollIntervalMs: 10,
      messageLimit: 20,
      sessionRef: { id: 'ses_1' },
      fallbackSessionID: 'ses_1',
    },
  );
  return { poller, injected };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InboundPoller', () => {
  it('skips a message not from the user\'s own account and logs it', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { poller, injected } = makePoller(
      () => [
        { id: 'm1', text: 'hello', senderID: '@other:beeper.com', isSender: false },
      ],
      log,
    );

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // seed resolves, interval registered
    await vi.advanceTimersByTimeAsync(10); // first poll fires

    expect(injected).toEqual([]);
    expect(log.some((l) => l.includes('skipping message m1'))).toBe(true);
    poller.stop();
  });

  it('injects a message from the user\'s own account', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { poller, injected } = makePoller(
      () => [
        { id: 'm1', text: 'hello', senderID: '@me:beeper.com', isSender: true },
      ],
      log,
    );

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    expect(injected).toEqual(['hello']);
    poller.stop();
  });

  it('injects a message without isSender (fail-open)', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { poller, injected } = makePoller(
      () => [{ id: 'm1', text: 'hello' }],
      log,
    );

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    expect(injected).toEqual(['hello']);
    poller.stop();
  });
});
