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
      const feedHttp = createChunkedDecoder((body) => parser.feed(body));
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
        sock.on('data', (chunk) => feedHttp(String(chunk)));
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
export function createChunkedDecoder(
  onBody: (chunk: string) => void,
): (chunk: string) => void {
  let buffer = '';
  let inHeaders = true;
  let chunkRemaining = 0; // bytes of the current chunk body still expected

  return (chunk) => {
    buffer += chunk;

    while (true) {
      if (inHeaders) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        buffer = buffer.slice(headerEnd + 4);
        inHeaders = false;
        continue;
      }

      if (chunkRemaining === 0) {
        // Expect a chunk-size line: "<hex>[;ext]\r\n"
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const sizeLine = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const size = parseInt(sizeLine.split(';')[0] ?? '', 16);
        if (size === 0) return; // last-chunk marker; ignore trailers
        chunkRemaining = size;
        continue;
      }

      if (buffer.length < chunkRemaining + 1) return; // wait for full chunk + terminator
      onBody(buffer.slice(0, chunkRemaining));
      // Skip the chunk terminator: CRLF per spec, but tolerate a bare LF —
      // a mis-skipped byte here would eat the next chunk-size line's first
      // hex digit and corrupt the stream.
      let skip = 1;
      if (
        buffer[chunkRemaining] === '\r' &&
        buffer[chunkRemaining + 1] === '\n'
      )
        skip = 2;
      buffer = buffer.slice(chunkRemaining + skip);
      chunkRemaining = 0;
    }
  };
}
