import { describe, expect, it, vi, afterEach } from 'vitest';
import { TurnWatcher } from '../../src/App/TurnWatcher.js';
import type { SessionPort } from '../../src/Domain/Ports/SessionPort.js';
import type { PublishTurnAction } from '../../src/Domain/Actions/PublishTurnAction.js';
import type { LoggerPort } from '../../src/Domain/Ports/LoggerPort.js';

const logger: LoggerPort = { info: () => {}, debug: () => {}, error: () => {} };

function partEvent(type: string, part: Record<string, unknown>) {
  return {
    event: 'message.part.updated',
    data: { properties: { part: { type, ...part } } },
  };
}

function textPart(id: string, messageID: string, text: string) {
  return partEvent('text', { id, messageID, text });
}

function toolPart(id: string, messageID: string, status: string) {
  return partEvent('tool', {
    id,
    messageID,
    tool: 'bash',
    state: { status },
  });
}

function roleEvent(messageID: string, role: string) {
  return {
    event: 'message.updated',
    data: { properties: { info: { id: messageID, role } } },
  };
}

function makeMessage(parts: Array<Record<string, unknown>>) {
  return { parts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TurnWatcher', () => {
  it('holds the turn while a tool runs and publishes the whole turn once it settles', async () => {
    // Given — a session whose message is mid-flight: a running tool
    const published: Array<{ messageIDs: string[]; fallbackText?: string }> = [];
    const publishTurn = {
      execute: async (input: {
        messageIDs: string[];
        fallbackText?: string;
      }) => {
        published.push(input);
      },
    } as unknown as PublishTurnAction;
    const messages = new Map<string, Record<string, unknown>>();
    const session: SessionPort = {
      async getSession() {
        return null;
      },
      async promptAsync() {},
      async getMessage(_sessionID, messageID) {
        return messages.get(messageID) ?? null;
      },
      async subscribeEvents() {
        throw new Error('not used in this test');
      },
    };
    const sessionRef = { id: 'ses_1' };
    const watcher = new TurnWatcher(
      publishTurn,
      session,
      logger,
      sessionRef,
    );

    vi.useFakeTimers();

    // The assistant message announces itself before its parts stream.
    watcher.handleEvent(roleEvent('msg_1', 'assistant'));

    // When — the reply opens with text, then a tool starts running
    watcher.handleEvent(textPart('p1', 'msg_1', 'Let me look at this.'));
    watcher.handleEvent(toolPart('p2', 'msg_1', 'running'));
    messages.set('msg_1', makeMessage([
      { type: 'text', text: 'Let me look at this.' },
      { type: 'tool', state: { status: 'running' } },
    ]));

    // Then — the debounce fires but the turn is held: nothing published
    await vi.advanceTimersByTimeAsync(3000);
    expect(published).toEqual([]);

    // When — the tool completes and the reply's closing text arrives
    watcher.handleEvent(toolPart('p2', 'msg_1', 'completed'));
    watcher.handleEvent(textPart('p3', 'msg_1', 'Here is what I found.'));
    messages.set('msg_1', makeMessage([
      { type: 'text', text: 'Let me look at this.' },
      { type: 'tool', state: { status: 'completed' } },
      { type: 'text', text: 'Here is what I found.' },
    ]));

    // Then — once quiet, the WHOLE turn publishes in one message
    await vi.advanceTimersByTimeAsync(3000);
    expect(published).toHaveLength(1);
    expect(published[0]!.messageIDs).toEqual(['msg_1']);
    expect(published[0]!.fallbackText).toBe(
      'Let me look at this.\nHere is what I found.',
    );
  });

  it('publishes a text-only turn after the debounce', async () => {
    const published: Array<{ messageIDs: string[] }> = [];
    const publishTurn = {
      execute: async (input: { messageIDs: string[] }) => {
        published.push(input);
      },
    } as unknown as PublishTurnAction;
    const session: SessionPort = {
      async getSession() {
        return null;
      },
      async promptAsync() {},
      async getMessage() {
        return null;
      },
      async subscribeEvents() {
        throw new Error('not used in this test');
      },
    };
    const watcher = new TurnWatcher(
      publishTurn,
      session,
      logger,
      { id: 'ses_1' },
    );

    vi.useFakeTimers();
    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Done.'));
    await vi.advanceTimersByTimeAsync(3000);

    expect(published).toHaveLength(1);
    expect(published[0]!.messageIDs).toEqual(['msg_1']);
  });

  it('never re-publishes a turn whose message already went out', async () => {
    const published: Array<{ messageIDs: string[] }> = [];
    const publishTurn = {
      execute: async (input: { messageIDs: string[] }) => {
        published.push(input);
      },
    } as unknown as PublishTurnAction;
    const session: SessionPort = {
      async getSession() {
        return null;
      },
      async promptAsync() {},
      async getMessage() {
        return null;
      },
      async subscribeEvents() {
        throw new Error('not used in this test');
      },
    };
    const watcher = new TurnWatcher(
      publishTurn,
      session,
      logger,
      { id: 'ses_1' },
    );

    vi.useFakeTimers();
    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Done.'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(published).toHaveLength(1);

    // A late duplicate part event for the same message must not re-publish.
    watcher.handleEvent(textPart('p1', 'msg_1', 'Done.'));
    await vi.advanceTimersByTimeAsync(3000);

    expect(published).toHaveLength(1);
  });
});
