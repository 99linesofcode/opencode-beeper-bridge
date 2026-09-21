import { describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { OpencodeSocketAdapter } from '../../../src/Infrastructure/Opencode/OpencodeSocketAdapter.js';
import type { LoggerPort } from '../../../src/Domain/Ports/LoggerPort.js';

const logger: LoggerPort = { info: () => {}, debug: () => {}, error: () => {} };

describe('OpencodeSocketAdapter', () => {
  it('settles the subscription when the server accepts but never responds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-test-'));
    const sockPath = path.join(dir, 'sock');
    const server = net.createServer((socket) => {
      // Accept the connection but never send a response byte.
      socket.on('data', () => {});
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const adapter = new OpencodeSocketAdapter(sockPath, logger, {
        firstByteTimeoutMs: 50,
      });
      const sub = await adapter.subscribeEvents(() => {}, 'ses_1');
      const start = Date.now();
      await sub.done;
      // The injected short timeout bounds the wait; a real multi-second
      // hang would fail this assertion.
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
