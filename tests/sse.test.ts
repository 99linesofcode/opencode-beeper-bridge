import { describe, expect, it } from 'vitest';
import { createSseParser, type SSEEvent } from '../src/sse.js';

function collect(): { feed(chunk: string): void; events: SSEEvent[] } {
  const events: SSEEvent[] = [];
  return { feed: createSseParser((event) => events.push(event)).feed, events };
}

describe('createSseParser', () => {
  it('derives the event type from bare JSON data', () => {
    const { feed, events } = collect();

    feed('data: {"type":"session.idle","properties":{}}\n\n');

    expect(events).toEqual([
      { event: 'session.idle', data: { type: 'session.idle', properties: {} } },
    ]);
  });

  it('keeps non-JSON data as raw text under the default event name', () => {
    const { feed, events } = collect();

    feed('data: not-json\n\n');

    expect(events).toEqual([{ event: 'message', data: 'not-json' }]);
  });

  it('skips comment and heartbeat-only blocks', () => {
    const { feed, events } = collect();

    feed(': ping\n\n: connected\n\n');

    expect(events).toEqual([]);
  });

  it('recovers two events merged into one block by a lost separator', () => {
    const { feed, events } = collect();

    feed('data: {"type":"a"}\ndata: {"type":"b"}\n\n');

    expect(events.map((e) => e.event)).toEqual(['a', 'b']);
  });

  it('buffers partial blocks across feeds', () => {
    const { feed, events } = collect();

    feed('data: {"type":"par');
    feed('tial"}\n\n');

    expect(events.map((e) => e.event)).toEqual(['partial']);
  });
});
