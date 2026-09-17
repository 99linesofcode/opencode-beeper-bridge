// Audio transcription.
//
// Single responsibility: turn a Beeper voice-note attachment into text.
// Attachments come in two forms:
//   - file:// — a local path Beeper has already downloaded to its media dir.
//   - mxc:// — a Matrix content URI, possibly encrypted. The bridge downloads
//     it from the media server and decrypts with AES-256-CTR using the key/IV
//     embedded in the attachment's encryptedFileInfoJSON.
// The audio is converted to WAV 16kHz mono with ffmpeg (voxtype's required
// input) and transcribed with the voxtype CLI. ffmpeg + voxtype must be on
// PATH.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { type BeeperAttachment } from './beeper.js';
import { type Logger } from './log.js';

export type TranscriptionResult = {
  text: string;
  fileName: string;
};

// The first audio attachment on a message, if any.
export function firstAudioAttachment(message: {
  attachments?: BeeperAttachment[];
}): BeeperAttachment | undefined {
  return message.attachments?.find(
    (a) => a.type === 'audio' || a.mimeType?.startsWith('audio/'),
  );
}

// Transcribe an audio attachment to text. Returns null when the attachment
// cannot be resolved, the conversion fails, or voxtype produces no output.
export async function transcribeAttachment(
  attachment: BeeperAttachment,
  logger: Logger,
): Promise<TranscriptionResult | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-bridge-'));
  try {
    const audio = await resolveAudio(attachment, tmpDir, logger);
    if (!audio) return null;

    const wav = path.join(tmpDir, 'audio.wav');
    const converted = await run(
      'ffmpeg',
      ['-y', '-i', audio, '-ar', '16000', '-ac', '1', wav],
      logger,
    );
    if (!converted.ok) return null;

    const text = await run('voxtype', ['transcribe', wav], logger);
    if (!text.ok) return null;
    // Voxtype logs to stdout before the transcript; the transcript is the
    // last non-empty line.
    const lines = text.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const transcript = lines[lines.length - 1];
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
async function resolveAudio(
  attachment: BeeperAttachment,
  tmpDir: string,
  logger: Logger,
): Promise<string | null> {
  const url = attachment.srcURL;
  if (!url) return null;

  if (url.startsWith('file://')) {
    const src = url.slice('file://'.length);
    if (!fs.existsSync(src)) {
      logger.info(`attachment file ${src} not found; skipping`);
      return null;
    }
    return src;
  }

  if (url.startsWith('mxc://')) {
    return await resolveMxc(attachment, url, tmpDir, logger);
  }

  logger.info(
    `attachment ${attachment.id} has unsupported srcURL ${url}; skipping`,
  );
  return null;
}

// Download an mxc:// attachment and decrypt it if encrypted. Returns the
// local plaintext file path.
async function resolveMxc(
  attachment: BeeperAttachment,
  url: string,
  tmpDir: string,
  logger: Logger,
): Promise<string | null> {
  // The encryptedFileInfoJSON query param carries the key/IV/hash.
  const info = parseEncryptedInfo(url);
  const mxc = info?.url ?? url.split('?')[0] ?? '';
  const httpUrl = mxcToHttp(mxc);
  if (!httpUrl) {
    logger.info(
      `attachment ${attachment.id}: cannot resolve mxc URL ${mxc}; skipping`,
    );
    return null;
  }

  const out = path.join(tmpDir, 'audio.bin');
  const ok = await download(httpUrl, out, logger);
  if (!ok) return null;

  if (!info) {
    // Unencrypted mxc: the downloaded bytes are the plaintext.
    return out;
  }

  const plain = path.join(tmpDir, 'audio.plain');
  if (!decrypt(info, out, plain, logger)) return null;
  return plain;
}

type EncryptedInfo = {
  iv: string;
  key: { k: string };
  url?: string;
};

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
function mxcToHttp(mxc: string): string | null {
  const m = mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return `https://matrix.beeper.com/_matrix/client/v1/media/download/${m[1]}/${m[2]}`;
}

// Download a URL to a file, following redirects. Returns true on success.
async function download(
  url: string,
  out: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      logger.error(`download ${url}: HTTP ${res.status}`);
      return false;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    fs.writeFileSync(out, bytes);
    return true;
  } catch (err) {
    logger.error(`download ${url}: ${err}`);
    return false;
  }
}

// Decrypt an AES-256-CTR encrypted media blob. The key is url-safe base64;
// the IV is the 128-bit initial counter block.
function decrypt(
  info: EncryptedInfo,
  src: string,
  out: string,
  logger: Logger,
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
    fs.writeFileSync(out, plaintext);
    return true;
  } catch (err) {
    logger.error(`decrypt: ${err}`);
    return false;
  }
}

// Run a command, capture stdout, return the exit code and output. Success is
// the exit code — ffmpeg writes progress to stderr, so stdout may be empty
// even on success.
async function run(
  command: string,
  args: string[],
  logger: Logger,
): Promise<{ ok: boolean; stdout: string }> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk));
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise<number>((resolve) =>
    child.on('exit', resolve),
  );
  if (code !== 0) {
    logger.error(`${command} failed (${code}): ${stderr.trim().slice(0, 300)}`);
    return { ok: false, stdout: '' };
  }
  return { ok: true, stdout: stdout.trim() };
}
