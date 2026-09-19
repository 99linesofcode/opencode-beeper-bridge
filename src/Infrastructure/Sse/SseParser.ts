// SSE parsing. Turns a byte stream into discrete SSE events. Scoped to the
// two producers this bridge talks to: both send bare `data:` lines with the
// event type inside the JSON payload. `event:` lines are not correlated to
// data and multi-line data is not joined — don't feed this parser a
// spec-general stream.
import type { SessionEvent } from '../../Domain/Ports/SessionPort.js';

export class SseParser {
  private buffer = '';

  constructor(private readonly onEvent: (event: SessionEvent) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.emitBlock(block);
    }
  }

  // A lost separator can merge two events into one block ("...}\ndata: {...").
  // Split on embedded data-line starts so both events survive instead of one
  // being dropped as unparseable. The split drops the "data: " prefix from
  // every part after the first — restore it before parsing.
  private emitBlock(block: string): void {
    const parts = block.split('\ndata: ');
    for (const [i, part] of parts.entries()) {
      const restored = i === 0 ? part : `data: ${part}`;
      const event = this.parseBlock(restored);
      if (event) this.onEvent(event);
    }
  }

  private parseBlock(block: string): SessionEvent | undefined {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment / heartbeat
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return undefined;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* keep raw string */
    }
    // The opencode socket plugin sends bare "data: {json}" with no "event:"
    // line — the event type lives inside the JSON. Derive it when absent.
    if (
      event === 'message' &&
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { type?: unknown }).type === 'string'
    ) {
      event = (data as { type: string }).type;
    }
    return { event, data };
  }
}
