// opencode adapter. Talks to the socket plugin's Unix socket over HTTP
// (node:http with the socketPath option) and maps responses onto the core's
// shapes. The bridge's only knowledge of the opencode HTTP API lives here.
import http from 'node:http';
import net from 'node:net';
import type {
  SessionEvent,
  SessionPort,
  SessionSubscription,
} from '../../Domain/Ports/SessionPort.js';
import type { LoggerPort } from '../../Domain/Ports/LoggerPort.js';
import { ChunkedDecoder } from './ChunkedDecoder.js';
import { SseParser } from '../Sse/SseParser.js';

// A socket that accepts but never responds would leave `done` pending
// forever and stall the reconnect loop — bound connect + first byte.
export const SSE_FIRST_BYTE_TIMEOUT_MS = 15_000;

export type OpencodeSocketAdapterOptions = {
  firstByteTimeoutMs?: number;
};

export class OpencodeSocketAdapter implements SessionPort {
  constructor(
    private readonly socketPath: string,
    private readonly logger: LoggerPort,
    private readonly options: OpencodeSocketAdapterOptions = {},
  ) {}

  async getSession(sessionID: string): Promise<unknown> {
    const { status, text } = await request(
      this.socketPath,
      'GET',
      `/session/${sessionID}`,
    );
    if (status === 404) return null;
    if (status !== 200) {
      throw new Error(`GET /session/${sessionID}: HTTP ${status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async promptAsync(sessionID: string, text: string): Promise<void> {
    const body = JSON.stringify({ parts: [{ type: 'text', text }] });
    const { status, text: resText } = await request(
      this.socketPath,
      'POST',
      `/session/${sessionID}/prompt_async`,
      body,
    );
    if (status !== 200) {
      throw new Error(`POST prompt_async: HTTP ${status}: ${resText}`);
    }
  }

  async getMessage(sessionID: string, messageID: string): Promise<unknown> {
    const { status, text } = await request(
      this.socketPath,
      'GET',
      `/session/${sessionID}/message/${messageID}`,
    );
    if (status !== 200) {
      throw new Error(`GET message: HTTP ${status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async subscribeEvents(
    onEvent: (event: SessionEvent) => void,
    sessionID?: string | null,
  ): Promise<SessionSubscription> {
    // node:http does not stream chunked responses over socketPath in Bun,
    // so use a raw unix socket with a minimal HTTP/1.1 GET. The response is
    // a continuous SSE stream, chunked by Bun.serve — de-chunk the body
    // before feeding the SSE parser. Request only the event types the bridge
    // consumes; the plugin forwards nothing else, so the TUI's event loop
    // isn't burdened serializing every token-chunk event. The ?session=
    // filter narrows the stream to one session; the plugin drops everything
    // else before it reaches the socket.
    const parser = new SseParser(onEvent);
    const textDecoder = new TextDecoder();
    // Decode only at complete-body boundaries: a chunk body is a complete
    // SSE block, so a multi-byte character is never split mid-decode.
    const feedHttp = new ChunkedDecoder((body) =>
      parser.feed(textDecoder.decode(body)),
    );
    const params = new URLSearchParams({
      events: 'message.updated,message.part.updated,session.status,session.idle',
    });
    if (sessionID) params.set('session', sessionID);
    const path = `/event?${params}`;
    const sock = net.connect(this.socketPath);
    const done = new Promise<void>((resolve, reject) => {
      // Bound connect + first byte: a socket that accepts but never responds
      // would leave `done` pending forever and stall the reconnect loop.
      // Destroying the socket fires 'close', which resolves `done` below and
      // lets the retry loop reconnect.
      const timeoutMs =
        this.options.firstByteTimeoutMs ?? SSE_FIRST_BYTE_TIMEOUT_MS;
      let firstByteTimer: ReturnType<typeof setTimeout> | null = setTimeout(
        () => {
          this.logger.error(
            `SSE no response within ${timeoutMs}ms; destroying socket`,
          );
          sock.destroy();
        },
        timeoutMs,
      );
      const clearFirstByteTimer = () => {
        if (firstByteTimer) {
          clearTimeout(firstByteTimer);
          firstByteTimer = null;
        }
      };
      sock.on('error', (err) => {
        clearFirstByteTimer();
        this.logger.error(`SSE connect error: ${err.message}`);
        reject(err);
      });
      sock.on('connect', () => {
        this.logger.debug(`SSE connected to ${this.socketPath}`);
        sock.write(
          `GET ${path} HTTP/1.1\r\n` +
            'Host: localhost\r\n' +
            'Accept: text/event-stream\r\n' +
            'Connection: keep-alive\r\n\r\n',
        );
      });
      sock.on('data', (chunk) => {
        clearFirstByteTimer();
        try {
          feedHttp.feed(chunk);
        } catch (err) {
          // Corrupt framing is unrecoverable — drop the connection so the
          // reconnect loop re-subscribes cleanly.
          this.logger.error(`SSE framing error: ${err}`);
          sock.destroy();
        }
      });
      sock.on('close', () => {
        clearFirstByteTimer();
        this.logger.debug('SSE connection closed');
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
  }
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
