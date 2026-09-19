// opencode socket HTTP client.
//
// Single responsibility: talk to the socket plugin's Unix socket over HTTP
// (node:http with the socketPath option). The bridge's only knowledge of the
// opencode HTTP API lives here.

import http from 'node:http';
import net from 'node:net';
import { createSseParser, type SSEEvent } from './sse.js';
import { type Config } from './config.js';
import { type Logger } from './log.js';

export type SseSubscription = {
  close(): void;
  done: Promise<void>;
};

export type OpencodeClient = {
  getSession(sessionID: string): Promise<unknown>;
  promptAsync(sessionID: string, text: string): Promise<void>;
  getMessage(sessionID: string, messageID: string): Promise<unknown>;
  subscribeEvents(
    onEvent: (event: SSEEvent) => void,
    sessionID?: string | null,
  ): Promise<SseSubscription>;
};

export function createOpencodeClient(
  config: Config,
  logger: Logger,
): OpencodeClient {
  const socketPath = config.opencodeSocketPath;

  return {
    async getSession(sessionID) {
      const { status, text } = await request(
        socketPath,
        'GET',
        `/session/${sessionID}`,
      );
      if (status === 404) return null;
      if (status !== 200)
        throw new Error(`GET /session/${sessionID}: HTTP ${status}: ${text}`);
      return text ? JSON.parse(text) : null;
    },

    async promptAsync(sessionID, text) {
      const body = JSON.stringify({ parts: [{ type: 'text', text }] });
      const { status, text: resText } = await request(
        socketPath,
        'POST',
        `/session/${sessionID}/prompt_async`,
        body,
      );
      if (status !== 200)
        throw new Error(`POST prompt_async: HTTP ${status}: ${resText}`);
    },

    async getMessage(sessionID, messageID) {
      const { status, text } = await request(
        socketPath,
        'GET',
        `/session/${sessionID}/message/${messageID}`,
      );
      if (status !== 200)
        throw new Error(`GET message: HTTP ${status}: ${text}`);
      return text ? JSON.parse(text) : null;
    },

    async subscribeEvents(onEvent, sessionID) {
      // node:http does not stream chunked responses over socketPath in Bun,
      // so use a raw unix socket with a minimal HTTP/1.1 GET. The response is
      // a continuous SSE stream, chunked by Bun.serve — de-chunk the body
      // before feeding the SSE parser. Request only the event types the
      // bridge consumes; the plugin forwards nothing else, so the TUI's
      // event loop isn't burdened serializing every token-chunk event.
      // The ?session= filter narrows the stream to one session; the plugin
      // drops everything else before it reaches the socket.
      const parser = createSseParser(onEvent);
      const textDecoder = new TextDecoder();
      // Decode only at complete-body boundaries: a chunk body is a complete
      // SSE block, so a multi-byte character is never split mid-decode.
      const feedHttp = createChunkedDecoder((body) =>
        parser.feed(textDecoder.decode(body)),
      );
      const params = new URLSearchParams({
        events: 'message.updated,message.part.updated',
      });
      if (sessionID) params.set('session', sessionID);
      const path = `/event?${params}`;
      const sock = net.connect(socketPath);
      const done = new Promise<void>((resolve, reject) => {
        sock.on('error', (err) => {
          logger.error(`SSE connect error: ${err.message}`);
          reject(err);
        });
        sock.on('connect', () => {
          logger.debug(`SSE connected to ${socketPath}`);
          sock.write(
            `GET ${path} HTTP/1.1\r\n` +
              'Host: localhost\r\n' +
              'Accept: text/event-stream\r\n' +
              'Connection: keep-alive\r\n\r\n',
          );
        });
        sock.on('data', (chunk) => {
          try {
            feedHttp(chunk);
          } catch (err) {
            // Corrupt framing is unrecoverable — drop the connection so the
            // reconnect loop re-subscribes cleanly.
            logger.error(`SSE framing error: ${err}`);
            sock.destroy();
          }
        });
        sock.on('close', () => {
          logger.debug('SSE connection closed');
          resolve();
        });
      });
      return {
        close() {
          // Graceful shutdown: sends FIN, the plugin sees the client
          // disconnect and drops the subscription.
          sock.end();
        },
        done,
      };
    },
  };
}

function request(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        socketPath,
        path,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Minimal HTTP chunked-transfer decoder. Bun.serve streams SSE responses with
// Transfer-Encoding: chunked; the raw socket client must strip the framing
// (hex size lines + trailing CRLF) before the body reaches the SSE parser.
//
// Byte-accurate by design: chunk sizes are byte counts, so all slicing happens
// on bytes. Text decoding is the caller's job, at complete-body boundaries —
// decoding per TCP segment corrupts multi-byte UTF-8 split across segments,
// and slicing by string length desyncs the framing on any multi-byte body.
export function createChunkedDecoder(
  onBody: (chunk: Uint8Array) => void,
): (chunk: Uint8Array) => void {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let inHeaders = true;
  let chunkRemaining = 0; // bytes of the current chunk body still expected
  const sizeLineDecoder = new TextDecoder();

  return (chunk) => {
    buffer = concat(buffer, chunk);

    while (true) {
      if (inHeaders) {
        const headerEnd = indexOfDoubleCRLF(buffer);
        if (headerEnd === -1) return;
        buffer = buffer.subarray(headerEnd + 4);
        inHeaders = false;
        continue;
      }

      if (chunkRemaining === 0) {
        // Expect a chunk-size line: "<hex>[;ext]\r\n". Anything unparsable
        // means the framing is corrupt — fail loudly so the caller can drop
        // the connection, instead of silently emitting garbage bodies.
        const lineEnd = indexOfCRLF(buffer);
        if (lineEnd === -1) return;
        const sizeLine = sizeLineDecoder.decode(buffer.subarray(0, lineEnd));
        buffer = buffer.subarray(lineEnd + 2);
        const size = Number.parseInt(sizeLine.split(';')[0] ?? '', 16);
        if (!Number.isInteger(size) || size < 0) {
          throw new Error(`malformed chunk size line: "${sizeLine}"`);
        }
        if (size === 0) return; // last-chunk marker; ignore trailers
        chunkRemaining = size;
        continue;
      }

      if (buffer.length < chunkRemaining + 1) return; // wait for full chunk + terminator
      onBody(buffer.subarray(0, chunkRemaining));
      // Skip the chunk terminator: CRLF per spec, but tolerate a bare LF —
      // a mis-skipped byte here would eat the next chunk-size line's first
      // hex digit and corrupt the stream.
      const skip =
        buffer[chunkRemaining] === 0x0d && buffer[chunkRemaining + 1] === 0x0a
          ? 2
          : 1;
      buffer = buffer.subarray(chunkRemaining + skip);
      chunkRemaining = 0;
    }
  };
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
