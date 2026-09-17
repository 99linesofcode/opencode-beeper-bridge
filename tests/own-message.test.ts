import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BeeperClient, type BeeperMessage } from '../src/beeper.js';
import { type Config } from '../src/config.js';
import { type Logger } from '../src/log.js';
import { createSentRegistry, type SentRegistry } from '../src/sent.js';
import { createOwnMessageRecorder } from '../src/own-message.js';

function fakeBeeper(messages: BeeperMessage[]): BeeperClient {
  return {
    async sendMessage() {
      return '';
    },
    async listMessages() {
      return messages;
    },
  };
}

const logger: Logger = { info: () => {}, debug: () => {}, error: () => {} };

const config: Config = {
  beeperToken: 'test',
  beeperMcpUrl: 'http://localhost',
  beeperChatId: '5000',
  opencodeSessionId: 'ses_1',
  opencodeSocketPath: '/tmp/opencode.sock',
  pollIntervalMs: 1000,
  messageLimit: 20,
  debug: false,
};

function recorder(beeper: BeeperClient, registry: SentRegistry) {
  return createOwnMessageRecorder(beeper, config, registry, logger);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createOwnMessageRecorder', () => {
  it('marks the matching message as own', async () => {
    const registry = createSentRegistry();
    const beeper = fakeBeeper([{ id: 'msg_1', text: 'hello from the bridge' }]);

    await recorder(beeper, registry)('hello from the bridge');

    expect(registry.isOwn('msg_1')).toBe(true);
  });

  it('matches a truncated copy of a long message', async () => {
    // Beeper truncates long messages in its HTML rendering; the prefix
    // comparison must still correlate the truncated copy.
    const registry = createSentRegistry();
    const sent = 'x'.repeat(300);
    const beeper = fakeBeeper([{ id: 'msg_1', text: sent.slice(0, 150) }]);

    await recorder(beeper, registry)(sent);

    expect(registry.isOwn('msg_1')).toBe(true);
  });

  it('does not mark unrelated messages', async () => {
    vi.useFakeTimers();
    const registry = createSentRegistry();
    const beeper = fakeBeeper([{ id: 'msg_1', text: 'completely unrelated' }]);

    const done = recorder(beeper, registry)('hello from the bridge');
    await vi.advanceTimersByTimeAsync(1500);
    await done;

    expect(registry.isOwn('msg_1')).toBe(false);
  });

  it('gives up after three attempts when the message never appears', async () => {
    vi.useFakeTimers();
    const registry = createSentRegistry();
    const beeper = fakeBeeper([]);

    const done = recorder(beeper, registry)('hello');
    await vi.advanceTimersByTimeAsync(1500);
    await done;

    expect(registry.isOwn('msg_1')).toBe(false);
  });
});
