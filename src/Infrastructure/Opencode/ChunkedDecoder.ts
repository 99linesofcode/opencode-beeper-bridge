// Minimal HTTP chunked-transfer decoder. Bun.serve streams SSE responses
// with Transfer-Encoding: chunked; the raw socket client must strip the
// framing (hex size lines + trailing CRLF) before the body reaches the SSE
// parser.
//
// Byte-accurate by design: chunk sizes are byte counts, so all slicing
// happens on bytes. Text decoding is the caller's job, at complete-body
// boundaries — decoding per TCP segment corrupts multi-byte UTF-8 split
// across segments, and slicing by string length desyncs the framing on any
// multi-byte body.
export class ChunkedDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private inHeaders = true;
  private chunkRemaining = 0; // bytes of the current chunk body still expected
  private readonly sizeLineDecoder = new TextDecoder();

  constructor(private readonly onBody: (chunk: Uint8Array) => void) {}

  feed(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk);

    while (true) {
      if (this.inHeaders) {
        const headerEnd = indexOfDoubleCRLF(this.buffer);
        if (headerEnd === -1) return;
        this.buffer = this.buffer.subarray(headerEnd + 4);
        this.inHeaders = false;
        continue;
      }

      if (this.chunkRemaining === 0) {
        // Expect a chunk-size line: "<hex>[;ext]\r\n". Anything unparsable
        // means the framing is corrupt — fail loudly so the caller can drop
        // the connection, instead of silently emitting garbage bodies.
        const lineEnd = indexOfCRLF(this.buffer);
        if (lineEnd === -1) return;
        const sizeLine = this.sizeLineDecoder.decode(
          this.buffer.subarray(0, lineEnd),
        );
        this.buffer = this.buffer.subarray(lineEnd + 2);
        const size = Number.parseInt(sizeLine.split(';')[0] ?? '', 16);
        if (!Number.isInteger(size) || size < 0) {
          throw new Error(`malformed chunk size line: "${sizeLine}"`);
        }
        if (size === 0) return; // last-chunk marker; ignore trailers
        this.chunkRemaining = size;
        continue;
      }

      if (this.buffer.length < this.chunkRemaining + 1) return; // wait for full chunk + terminator
      this.onBody(this.buffer.subarray(0, this.chunkRemaining));
      // Skip the chunk terminator: CRLF per spec, but tolerate a bare LF —
      // a mis-skipped byte here would eat the next chunk-size line's first
      // hex digit and corrupt the stream.
      const skip =
        this.buffer[this.chunkRemaining] === 0x0d &&
        this.buffer[this.chunkRemaining + 1] === 0x0a
          ? 2
          : 1;
      this.buffer = this.buffer.subarray(this.chunkRemaining + skip);
      this.chunkRemaining = 0;
    }
  }
}

function indexOfCRLF(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) return i;
  }
  return -1;
}

function indexOfDoubleCRLF(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length - 3; i++) {
    if (
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
