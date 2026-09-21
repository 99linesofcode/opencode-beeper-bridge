import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnWatcher } from '../../src/App/TurnWatcher.js';
import type { PostToChatAction } from '../../src/Domain/Actions/PostToChatAction.js';
import type { LoggerPort } from '../../src/Domain/Ports/LoggerPort.js';
import type { SessionEvent } from '../../src/Domain/Ports/SessionPort.js';

const logger: LoggerPort = { info: () => {}, debug: () => {}, error: () => {} };

function partEvent(type: string, part: Record<string, unknown>): SessionEvent {
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

function roleEvent(messageID: string, role: string): SessionEvent {
  return {
    event: 'message.updated',
    data: { properties: { info: { id: messageID, role } } },
  };
}

function idleEvent(): SessionEvent {
  return {
    event: 'session.status',
    data: {
      properties: {
        sessionID: 'ses_1',
        status: { type: 'idle' },
      },
    },
  };
}

function makeWatcher(published: Array<string>): TurnWatcher {
  const publishTurn = {
    execute: async (text: string) => {
      published.push(text);
    },
  } as unknown as PostToChatAction;
  return new TurnWatcher(publishTurn, logger, { id: 'ses_1' }, 0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TurnWatcher', () => {
  it('posts each assistant text part as it is produced (live progress)', async () => {
    vi.useFakeTimers();
    const published: Array<string> = [];
    const watcher = makeWatcher(published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Let me look at this.'));
    watcher.handleEvent(toolPart('p2', 'msg_1', 'running'));
    watcher.handleEvent(toolPart('p2', 'msg_1', 'completed'));
    watcher.handleEvent(textPart('p3', 'msg_1', 'All fixed. Here is the summary.'));

    // The debounce fires per part, so each text part posts on its own.
    await vi.runAllTimersAsync();

    expect(published).toEqual([
      'Let me look at this.',
      'All fixed. Here is the summary.',
    ]);
  });

  it('posts a streaming part once, with its final text', async () => {
    vi.useFakeTimers();
    const published: Array<string> = [];
    const watcher = makeWatcher(published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Part'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Part of'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Part of the answer.'));

    // The debounce resets on each update, so only the final text posts.
    await vi.runAllTimersAsync();

    expect(published).toEqual(['Part of the answer.']);
  });

  it('posts nothing when no assistant text arrived', async () => {
    vi.useFakeTimers();
    const published: Array<string> = [];
    const watcher = makeWatcher(published);

    watcher.handleEvent(idleEvent());
    await vi.runAllTimersAsync();

    expect(published).toEqual([]);
  });

  it('never re-posts a part whose message already went out', async () => {
    vi.useFakeTimers();
    const published: Array<string> = [];
    const watcher = makeWatcher(published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Done.'));
    await vi.runAllTimersAsync();
    expect(published).toEqual(['Done.']);

    // A late duplicate part event for the same message must not re-post.
    watcher.handleEvent(textPart('p1', 'msg_1', 'Done.'));
    await vi.runAllTimersAsync();

    expect(published).toEqual(['Done.']);
  });

  it('dedups the same content arriving under a different part ID', async () => {
    vi.useFakeTimers();
    const published: Array<string> = [];
    const watcher = makeWatcher(published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Same content'));
    await vi.runAllTimersAsync();
    expect(published).toEqual(['Same content']);

    // The same text re-emitted as a new part ID must not post again.
    watcher.handleEvent(textPart('p2', 'msg_1', 'Same content'));
    await vi.runAllTimersAsync();

    expect(published).toEqual(['Same content']);
  });

  it('does not double-post when two parts with the same text fire concurrently', async () => {
    // Real timers: two parts with the same text fire their debounce timers
    // concurrently; the first post is still awaiting, so the second must be
    // deduped by the first's pre-await mark.
    const published: Array<string> = [];
    const pending: Array<() => void> = [];
    const publishTurn = {
      execute: async (text: string) => {
        published.push(text);
        await new Promise<void>((resolve) => pending.push(resolve));
      },
    } as unknown as PostToChatAction;
    const watcher = new TurnWatcher(publishTurn, logger, { id: 'ses_1' }, 0);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Same content'));
    watcher.handleEvent(textPart('p2', 'msg_1', 'Same content'));

    await new Promise((r) => setTimeout(r, 20));
    expect(published).toEqual(['Same content']);

    for (const resolve of pending) resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(published).toEqual(['Same content']);
  });

  it('flushes a still-streaming part when the turn goes idle', async () => {
    vi.useFakeTimers();
    const published: Array<string> = [];
    const watcher = makeWatcher(published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Almost done'));
    // Idle fires before the debounce — the part must still be posted.
    watcher.handleEvent(idleEvent());
    await vi.runAllTimersAsync();

    expect(published).toEqual(['Almost done']);
  });

  it('drops a part from the map once it is posted', async () => {
    vi.useFakeTimers();
    const published: Array<string> = [];
    const watcher = makeWatcher(published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Done.'));
    expect(watcher.partsSize).toBe(1);

    await vi.runAllTimersAsync();

    expect(published).toEqual(['Done.']);
    expect(watcher.partsSize).toBe(0);
  });

  it('bounds the dedup set and evicts the oldest text', async () => {
    vi.useFakeTimers();
    const published: Array<string> = [];
    const watcher = makeWatcher(published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    // Post more distinct texts than the cap.
    for (let i = 0; i < 201; i++) {
      watcher.handleEvent(textPart(`p${i}`, 'msg_1', `text ${i}`));
    }
    await vi.runAllTimersAsync();

    expect(watcher.sentTextsSize).toBe(200);

    // The oldest text (text 0) was evicted, so re-posting it posts again.
    watcher.handleEvent(textPart('p_old', 'msg_1', 'text 0'));
    await vi.runAllTimersAsync();

    expect(published.filter((t) => t === 'text 0').length).toBe(2);
  });
});
