import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractTranscript,
  download,
  mxcToHttp,
  MAX_DOWNLOAD_BYTES,
} from '../../../src/Infrastructure/Voxtype/VoxtypeAdapter.js';
import type { LoggerPort } from '../../../src/Domain/Ports/LoggerPort.js';

const logger: LoggerPort = { info: () => {}, debug: () => {}, error: () => {} };

const LOG_PREFIX = '\u001b[2m2026-09-21T07:15:15.147498Z\u001b[0m \u001b[32m INFO\u001b[0m ';

describe('extractTranscript', () => {
  it('extracts the quoted transcript from the completion line', () => {
    const stdout = [
      'Processing 118720 samples (7.42s)...',
      LOG_PREFIX + 'Loading Parakeet Tdt model from "/tmp/models"',
      LOG_PREFIX + 'Parakeet Tdt model loaded in 3.55s',
      LOG_PREFIX + 'Parakeet Tdt transcription completed in 1.32s: "hello world"',
    ].join('\n');

    expect(extractTranscript(stdout)).toBe('hello world');
  });

  it('returns null when the transcript is empty (log line is not a transcript)', () => {
    const stdout =
      LOG_PREFIX + 'Parakeet Tdt transcription completed in 0.46s: ""';

    expect(extractTranscript(stdout)).toBeNull();
  });

  it('returns null when there is no completion line', () => {
    expect(extractTranscript('Processing 118720 samples...\n')).toBeNull();
  });

  it('trims whitespace around the transcript', () => {
    const stdout =
      LOG_PREFIX + 'Parakeet Tdt transcription completed in 1.00s: "  spaced  "';

    expect(extractTranscript(stdout)).toBe('spaced');
  });
});

describe('mxcToHttp', () => {
  it('encodes the server and mediaId path segments', () => {
    expect(mxcToHttp('mxc://exa mple.com/abc def')).toBe(
      'https://matrix.beeper.com/_matrix/client/v1/media/download/exa%20mple.com/abc%20def',
    );
  });

  it('returns null for a non-mxc URL', () => {
    expect(mxcToHttp('https://example.com/x')).toBeNull();
  });
});

describe('download', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a download whose Content-Length exceeds the cap before reading', async () => {
    // A real Response overrides content-length to the actual body size, so
    // stub a response object that reports an oversized declared length.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: {
          get: (name: string) =>
            name === 'content-length'
              ? String(MAX_DOWNLOAD_BYTES + 1)
              : null,
        },
        body: null,
      })),
    );
    const out = path.join(os.tmpdir(), 'dl-out.bin');

    const ok = await download('http://media/x', out, logger);

    expect(ok).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('aborts a stream that exceeds the byte cap', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const out = path.join(os.tmpdir(), 'dl-out.bin');

    // A small injected cap (1500 < 2048 streamed bytes) exercises the
    // running-byte-count path without writing 25 MB.
    const ok = await download('http://media/x', out, logger, 1500);

    expect(ok).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('writes a stream within the cap to disk', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const out = path.join(os.tmpdir(), 'dl-out.bin');

    const ok = await download('http://media/x', out, logger, 1500);

    expect(ok).toBe(true);
    expect([...fs.readFileSync(out)]).toEqual([1, 2, 3]);
    fs.rmSync(out, { force: true });
  });
});
