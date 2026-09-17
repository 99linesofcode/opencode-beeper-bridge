import { describe, expect, it } from 'vitest';
import { createChunkedDecoder } from '../src/socket.js';

// Collects decoded body chunks for a decoder instance.
function collect(): { feed(chunk: string): void; bodies: string[] } {
  const bodies: string[] = [];
  return { feed: createChunkedDecoder((body) => bodies.push(body)), bodies };
}

const HEADERS = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n';

describe('createChunkedDecoder', () => {
  it('decodes a single complete chunk', () => {
    const { feed, bodies } = collect();

    feed(`${HEADERS}4\r\ndata\r\n0\r\n\r\n`);

    expect(bodies).toEqual(['data']);
  });

  it('decodes consecutive chunks in order', () => {
    const { feed, bodies } = collect();

    feed(`${HEADERS}2\r\nhe\r\n2\r\ny!\r\n0\r\n\r\n`);

    expect(bodies).toEqual(['he', 'y!']);
  });

  it('waits for a chunk split across feeds', () => {
    const { feed, bodies } = collect();

    feed(`${HEADERS}6\r\nhel`);
    feed('lo!\r\n0\r\n\r\n');

    expect(bodies).toEqual(['hello!']);
  });

  it('tolerates a bare LF chunk terminator', () => {
    const { feed, bodies } = collect();

    feed(`${HEADERS}4\r\ndata\n0\r\n\r\n`);

    expect(bodies).toEqual(['data']);
  });

  it('ignores chunk-size extensions', () => {
    const { feed, bodies } = collect();

    feed(`${HEADERS}4;ext=1\r\ndata\r\n0\r\n\r\n`);

    expect(bodies).toEqual(['data']);
  });

  it('buffers headers split across feeds', () => {
    const { feed, bodies } = collect();

    feed('HTTP/1.1 200 OK\r\nTransfer-');
    feed('Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n');

    expect(bodies).toEqual(['x']);
  });

  it('stops at the final-chunk marker', () => {
    const { feed, bodies } = collect();

    feed(`${HEADERS}1\r\na\r\n0\r\n\r\ntrailer: ignored\r\n`);

    expect(bodies).toEqual(['a']);
  });
});
