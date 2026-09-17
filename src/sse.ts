// Server-Sent Events parsing.
//
// Single responsibility: turn a byte stream into discrete SSE events. Used by
// both the Beeper MCP client (one-shot responses) and the opencode socket SSE
// consumer (continuous stream). Pure state machine — no I/O.
//
// Scoped to those two producers: both send bare `data:` lines with the event
// type inside the JSON payload. `event:` lines are not correlated to data and
// multi-line data is not joined — don't feed this parser a spec-general stream.

export type SSEEvent = {
  event: string;
  data: unknown;
};

export type SseParser = {
  feed(chunk: string): void;
};

// Parse an SSE block (the text between blank lines) into an event. Comment
// lines (": ping") and heartbeat-only blocks are skipped.
function parseBlock(block: string): SSEEvent | undefined {
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

export function createSseParser(onEvent: (event: SSEEvent) => void): SseParser {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        emitBlock(block, onEvent);
      }
    },
  };
}

// A lost separator can merge two events into one block ("...}\ndata: {...").
// Split on embedded data-line starts so both events survive instead of one
// being dropped as unparseable. The split drops the "data: " prefix from
// every part after the first — restore it before parsing.
function emitBlock(block: string, onEvent: (event: SSEEvent) => void): void {
  const parts = block.split('\ndata: ');
  for (const [i, part] of parts.entries()) {
    const restored = i === 0 ? part : `data: ${part}`;
    const event = parseBlock(restored);
    if (event) onEvent(event);
  }
}
