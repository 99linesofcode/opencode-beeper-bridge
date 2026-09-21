// Voxtype adapter. Turns a Beeper audio attachment into text. Attachments
// come in two forms:
//   - file:// — a local path Beeper has already downloaded to its media dir.
//   - mxc:// — a Matrix content URI, possibly encrypted. The adapter
//     downloads it from the media server and decrypts with AES-256-CTR
//     using the key/IV embedded in the attachment's encryptedFileInfoJSON.
// The audio is converted to WAV 16kHz mono with ffmpeg (voxtype's required
// input) and transcribed with the voxtype CLI. ffmpeg + voxtype must be on
// PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  AudioAttachmentData,
} from '../../Domain/DataTransferObjects/AudioAttachmentData.js';
import type {
  TranscriptionData,
} from '../../Domain/DataTransferObjects/TranscriptionData.js';
import type { TranscriptionPort } from '../../Domain/Ports/TranscriptionPort.js';
import type { LoggerPort } from '../../Domain/Ports/LoggerPort.js';

export class VoxtypeAdapter implements TranscriptionPort {
  constructor(private readonly logger: LoggerPort) {}

  async transcribe(
    attachment: AudioAttachmentData,
  ): Promise<TranscriptionData | null> {
    const tmpDir = fs.mkdtempSync(path.join(tmpBaseDir(), 'beeper-bridge-'));
    try {
      const audio = await this.resolveAudio(attachment, tmpDir);
      if (!audio) return null;

      const wav = path.join(tmpDir, 'audio.wav');
      const converted = await run(
        'ffmpeg',
        ['-y', '-i', audio, '-ar', '16000', '-ac', '1', wav],
        this.logger,
      );
      if (!converted.ok) return null;

      const text = await run('voxtype', ['transcribe', wav], this.logger);
      if (!text.ok) return null;
      const transcript = extractTranscript(text.stdout);
      if (!transcript) return null;

      return {
        text: transcript,
        fileName: attachment.fileName ?? path.basename(audio),
      };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Resolve the attachment to a local audio file path inside tmpDir. Handles
  // file:// (already local) and mxc:// (download + decrypt).
  private async resolveAudio(
    attachment: AudioAttachmentData,
    tmpDir: string,
  ): Promise<string | null> {
    const url = attachment.srcURL;
    if (!url) return null;

    if (url.startsWith('file://')) {
      const src = url.slice('file://'.length);
      if (!fs.existsSync(src)) {
        this.logger.info(`attachment file ${src} not found; skipping`);
        return null;
      }
      return src;
    }

    if (url.startsWith('mxc://')) {
      return await this.resolveMxc(attachment, url, tmpDir);
    }

    this.logger.info(
      `attachment ${attachment.id} has unsupported srcURL ${url}; skipping`,
    );
    return null;
  }

  // Download an mxc:// attachment and decrypt it if encrypted. Returns the
  // local plaintext file path.
  private async resolveMxc(
    attachment: AudioAttachmentData,
    url: string,
    tmpDir: string,
  ): Promise<string | null> {
    // The encryptedFileInfoJSON query param carries the key/IV/hash.
    const info = parseEncryptedInfo(url);
    const mxc = info?.url ?? url.split('?')[0] ?? '';
    const httpUrl = mxcToHttp(mxc);
    if (!httpUrl) {
      this.logger.info(
        `attachment ${attachment.id}: cannot resolve mxc URL ${mxc}; skipping`,
      );
      return null;
    }

    const out = path.join(tmpDir, 'audio.bin');
    const ok = await download(httpUrl, out, this.logger);
    if (!ok) return null;

    if (!info) {
      // Unencrypted mxc: the downloaded bytes are the plaintext.
      return out;
    }

    const plain = path.join(tmpDir, 'audio.plain');
    if (!decrypt(info, out, plain, this.logger)) return null;
    return plain;
  }
}

type EncryptedInfo = {
  iv: string;
  key: { k: string };
  url?: string;
};

// mkdtemp base: prefer XDG_RUNTIME_DIR (tmpfs, cleared on reboot — leaked
// dirs from a SIGKILL vanish) with a fallback to the system temp dir.
function tmpBaseDir(): string {
  return process.env.XDG_RUNTIME_DIR || os.tmpdir();
}

// Parse the encryptedFileInfoJSON query parameter from an mxc:// URL.
function parseEncryptedInfo(url: string): EncryptedInfo | null {
  const match = url.match(/[?&]encryptedFileInfoJSON=([^&]+)/);
  if (!match) return null;
  try {
    const json = Buffer.from(
      decodeURIComponent(match[1] ?? ''),
      'base64',
    ).toString('utf8');
    return JSON.parse(json) as EncryptedInfo;
  } catch {
    return null;
  }
}

// mxc://server/mediaId → https://<homeserver>/_matrix/client/v1/media/download/<server>/<mediaId>
export function mxcToHttp(mxc: string): string | null {
  const m = mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const server = encodeURIComponent(m[1]!);
  const mediaId = encodeURIComponent(m[2]!);
  return `https://matrix.beeper.com/_matrix/client/v1/media/download/${server}/${mediaId}`;
}

// Download a URL to a file, following redirects. Returns true on success.
// Hard timeout: a media server that accepts the connection but never
// responds would otherwise hang the fetch forever — and with it the whole
// inbound poller (the poll's re-entrancy guard never clears). Hard byte cap:
// the attachment source is chat-controlled, so bound memory/disk use too.
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export async function download(
  url: string,
  out: string,
  logger: LoggerPort,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error(`download ${url}: HTTP ${res.status}`);
      return false;
    }
    // Reject by declared size before reading a single byte.
    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      logger.error(
        `download ${url}: content-length ${contentLength} exceeds cap ${maxBytes}`,
      );
      return false;
    }
    if (!res.body) {
      logger.error(`download ${url}: no response body`);
      return false;
    }
    // Stream to disk with a running byte count — a lying or absent
    // Content-Length can't bypass the cap.
    const file = fs.createWriteStream(out);
    let written = 0;
    for await (const chunk of res.body) {
      written += chunk.length;
      if (written > maxBytes) {
        file.destroy();
        fs.rmSync(out, { force: true });
        logger.error(`download ${url}: exceeded ${maxBytes} byte cap`);
        return false;
      }
      if (!file.write(chunk)) {
        await new Promise<void>((resolve) =>
          file.once('drain', () => resolve()),
        );
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return true;
  } catch (err) {
    logger.error(`download ${url}: ${err}`);
    return false;
  }
}

const DOWNLOAD_TIMEOUT_MS = 30_000;
const CHILD_TIMEOUT_MS = 120_000;

// Decrypt an AES-256-CTR encrypted media blob. The key is url-safe base64;
// the IV is the 128-bit initial counter block.
function decrypt(
  info: EncryptedInfo,
  src: string,
  out: string,
  logger: LoggerPort,
): boolean {
  try {
    const key = Buffer.from(
      info.key.k.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    const iv = Buffer.from(info.iv, 'base64');
    if (key.length !== 32 || iv.length !== 16) {
      logger.error(`decrypt: bad key/iv length (${key.length}/${iv.length})`);
      return false;
    }
    const ciphertext = fs.readFileSync(src);
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    // Owner-only: the decrypted audio is sensitive chat content.
    fs.writeFileSync(out, plaintext, { mode: 0o600 });
    return true;
  } catch (err) {
    logger.error(`decrypt: ${err}`);
    return false;
  }
}

// Extract the transcript from voxtype's stdout. Voxtype logs around the
// transcript; the transcript itself is the quoted value of the
// "transcription completed" line:
//   INFO Parakeet Tdt transcription completed in 1.32s: "hello world"
// Returns null when the line is absent or the quoted transcript is empty.
export function extractTranscript(stdout: string): string | null {
  const match = stdout.match(/transcription completed[^\n"]*"([^"]*)"/);
  const transcript = match?.[1]?.trim();
  return transcript ? transcript : null;
}

// Run a command, capture stdout, return the exit code and output. Success is
// the exit code — ffmpeg writes progress to stderr, so stdout may be empty
// even on success. Hard timeout: a hung child must not block the poller.
async function run(
  command: string,
  args: string[],
  logger: LoggerPort,
): Promise<{ ok: boolean; stdout: string }> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk));
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise<number>((resolve) => {
    child.on('exit', resolve);
    setTimeout(() => {
      logger.error(`${command} timed out after ${CHILD_TIMEOUT_MS}ms; killing`);
      child.kill('SIGKILL');
      resolve(-1);
    }, CHILD_TIMEOUT_MS).unref();
  });
  if (code !== 0) {
    logger.error(`${command} failed (${code}): ${stderr.trim().slice(0, 300)}`);
    return { ok: false, stdout: '' };
  }
  return { ok: true, stdout: stdout.trim() };
}
