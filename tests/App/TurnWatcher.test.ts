import { describe, expect, it } from 'vitest';
import { TurnWatcher } from '../../src/App/TurnWatcher.js';
import type { PublishTurnAction } from '../../src/Domain/Actions/PublishTurnAction.js';
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

function makeMessage(parts: Array<Record<string, unknown>>) {
  return { parts };
}

function makeWatcher(
  _messages: Map<string, Record<string, unknown>>,
  published: Array<{ messageIDs: string[]; fallbackText?: string }>,
): TurnWatcher {
  const publishTurn = {
    execute: async (input: {
      messageIDs: string[];
      fallbackText?: string;
    }) => {
      published.push(input);
    },
  } as unknown as PublishTurnAction;
  return new TurnWatcher(publishTurn, logger, { id: 'ses_1' });
}

describe('TurnWatcher', () => {
  it('publishes the summary when the session goes idle after a tool-heavy turn', async () => {
    // Given — a tool-heavy reply: opening text, tools, closing summary
    const messages = new Map<string, Record<string, unknown>>();
    const published: Array<{ messageIDs: string[]; fallbackText?: string }> = [];
    const watcher = makeWatcher(messages, published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Let me look at this.'));
    watcher.handleEvent(toolPart('p2', 'msg_1', 'running'));
    watcher.handleEvent(toolPart('p2', 'msg_1', 'completed'));
    watcher.handleEvent(textPart('p3', 'msg_1', 'All fixed. Here is the summary.'));
    messages.set('msg_1', makeMessage([
      { type: 'text', text: 'Let me look at this.' },
      { type: 'tool', state: { status: 'completed' } },
      { type: 'text', text: 'All fixed. Here is the summary.' },
    ]));

    // When — the session goes idle (the turn is complete)
    watcher.handleEvent(idleEvent());

    // Then — the summary publishes once, with the closing section only
    expect(published).toHaveLength(1);
    expect(published[0]!.messageIDs).toEqual(['msg_1']);
    expect(published[0]!.fallbackText).toBe('All fixed. Here is the summary.');
  });

  it('publishes nothing on idle when no assistant text arrived', async () => {
    const published: Array<{ messageIDs: string[] }> = [];
    const watcher = makeWatcher(new Map(), published);

    watcher.handleEvent(idleEvent());

    expect(published).toEqual([]);
  });

  it('never re-publishes a turn whose message already went out', async () => {
    const published: Array<{ messageIDs: string[] }> = [];
    const watcher = makeWatcher(new Map(), published);

    watcher.handleEvent(roleEvent('msg_1', 'assistant'));
    watcher.handleEvent(textPart('p1', 'msg_1', 'Done.'));
    watcher.handleEvent(idleEvent());
    expect(published).toHaveLength(1);

    // A late duplicate part event for the same message must not re-publish.
    watcher.handleEvent(textPart('p1', 'msg_1', 'Done.'));
    watcher.handleEvent(idleEvent());

    expect(published).toHaveLength(1);
  });
});
