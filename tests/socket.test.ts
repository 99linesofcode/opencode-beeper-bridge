import { describe, expect, it } from 'vitest';
import { createChunkedDecoder } from '../src/socket.js';

// Collects decoded body chunks for a decoder instance. Bodies arrive as
// bytes; decoding to text happens here, at complete-body boundaries — the
// same contract the production call site uses.
function collect(): { feed(chunk: Uint8Array): void; bodies: string[] } {
  const bodies: string[] = [];
  const decode = new TextDecoder();
  return {
    feed: createChunkedDecoder((body) => bodies.push(decode.decode(body))),
    bodies,
  };
}

const HEADERS = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n';

// Frames a body as a complete chunked payload: headers + size line + body
// bytes + terminator. Chunk sizes are BYTE counts — the framing the wire
// actually carries.
function frame(body: string, headers = HEADERS): Buffer {
  const bodyBytes = Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(headers, 'utf8'),
    Buffer.from(`${bodyBytes.length.toString(16)}\r\n`, 'utf8'),
    bodyBytes,
    Buffer.from('\r\n', 'utf8'),
  ]);
}

describe('createChunkedDecoder', () => {
  it('decodes a single complete chunk', () => {
    const { feed, bodies } = collect();

    feed(frame('data'));

    expect(bodies).toEqual(['data']);
  });

  it('decodes consecutive chunks in order', () => {
    const { feed, bodies } = collect();

    feed(Buffer.concat([frame('he'), frame('y!', '')]));

    expect(bodies).toEqual(['he', 'y!']);
  });

  it('waits for a chunk split across feeds', () => {
    const { feed, bodies } = collect();

    const payload = frame('hello!');
    const sizeLineEnd = HEADERS.length + 2; // after "6\r\n"
    feed(payload.subarray(0, sizeLineEnd + 3));
    feed(payload.subarray(sizeLineEnd + 3));

    expect(bodies).toEqual(['hello!']);
  });

  it('tolerates a bare LF chunk terminator', () => {
    const { feed, bodies } = collect();

    const bodyBytes = Buffer.from('data', 'utf8');
    const payload = Buffer.concat([
      Buffer.from(HEADERS, 'utf8'),
      Buffer.from(`4\r\n`, 'utf8'),
      bodyBytes,
      Buffer.from('\n', 'utf8'),
    ]);

    feed(payload);

    expect(bodies).toEqual(['data']);
  });

  it('ignores chunk-size extensions', () => {
    const { feed, bodies } = collect();

    const bodyBytes = Buffer.from('data', 'utf8');
    const payload = Buffer.concat([
      Buffer.from(HEADERS, 'utf8'),
      Buffer.from(`4;ext=1\r\n`, 'utf8'),
      bodyBytes,
      Buffer.from('\r\n', 'utf8'),
    ]);

    feed(payload);

    expect(bodies).toEqual(['data']);
  });

  it('buffers headers split across feeds', () => {
    const { feed, bodies } = collect();

    feed(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-', 'utf8'));
    feed(Buffer.from('Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n', 'utf8'));

    expect(bodies).toEqual(['x']);
  });

  it('stops at the final-chunk marker', () => {
    const { feed, bodies } = collect();

    feed(
      Buffer.concat([
        frame('a'),
        Buffer.from('0\r\n\r\n', 'utf8'),
        Buffer.from('trailer: ignored\r\n', 'utf8'),
      ]),
    );

    expect(bodies).toEqual(['a']);
  });

  it('decodes multi-byte bodies and stays aligned for the next chunk', () => {
    const { feed, bodies } = collect();

    // Chunk sizes are byte counts; multi-byte UTF-8 makes char counts differ.
    // A char-counting decoder desyncs here and corrupts everything after.
    feed(frame('—🎙️— first'));
    feed(frame('second', ''));

    expect(bodies).toEqual(['—🎙️— first', 'second']);
  });

  it('decodes a multi-byte body split across segment boundaries', () => {
    const { feed, bodies } = collect();

    const body = '—🎙️— ok';
    const bodyBytes = Buffer.from(body, 'utf8');
    const head = Buffer.from(`${HEADERS}${bodyBytes.length.toString(16)}\r\n`, 'utf8');
    const payload = Buffer.concat([head, bodyBytes, Buffer.from('\r\n', 'utf8')]);

    // Split inside the first multi-byte character, as a TCP segment would.
    const splitAt = head.length + 2;
    feed(payload.subarray(0, splitAt));
    feed(payload.subarray(splitAt));

    expect(bodies).toEqual([body]);
  });

  it('keeps decoding after many multi-byte chunks', () => {
    const { feed, bodies } = collect();

    const payloads = ['— one', '🎙️ two', '三 three', '—🎙️— four'];
    payloads.forEach((payload, i) => feed(frame(payload, i === 0 ? HEADERS : '')));

    expect(bodies).toEqual(payloads);
  });

  it('throws on a malformed chunk-size line', () => {
    const { feed } = collect();

    expect(() =>
      feed(Buffer.from(`${HEADERS}not-hex\r\n`, 'utf8')),
    ).toThrow(/chunk size/i);
  });
});
