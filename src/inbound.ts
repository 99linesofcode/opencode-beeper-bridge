// Inbound poller.
//
// Single responsibility: watch the Beeper chat for new messages and inject
// them into the active opencode session. Tracks a last-seen cursor so each
// message is injected exactly once; skips the bridge's own outbound messages
// by their recorded message ID.

import {
  type BeeperClient,
  type BeeperMessage,
  type BeeperAttachment,
  extractText,
} from './beeper.js';
import { type OpencodeClient } from './socket.js';
import { type Config } from './config.js';
import { type Logger } from './log.js';
import { type SentRegistry } from './sent.js';
import { type Lock } from './lock.js';
import { createOwnMessageRecorder } from './own-message.js';
import { firstAudioAttachment, transcribeAttachment } from './transcribe.js';

export type InboundPoller = {
  start(): void;
  stop(): void;
};

export function createInboundPoller(
  config: Config,
  beeper: BeeperClient,
  opencode: OpencodeClient,
  logger: Logger,
  registry: SentRegistry,
  lock: Lock,
  sessionRef: { id: string | null },
): InboundPoller {
  let lastSeenID: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  const recordOwnMessage = createOwnMessageRecorder(
    beeper,
    config,
    registry,
    logger,
  );

  function start(): void {
    // Seed the cursor from the newest message so history is not replayed.
    // The first poll must wait for the seed to resolve, otherwise lastSeenID
    // is null and the entire chat history gets injected.
    void beeper
      .listMessages(config.beeperChatId, config.messageLimit)
      .then((messages) => {
        const newest = messages[0];
        if (newest) lastSeenID = newest.id;
        logger.info(`seeded cursor at ${lastSeenID ?? 'none'}`);
      })
      .catch((err) => logger.error(`seed error: ${err}`))
      .finally(() => {
        timer = setInterval(() => void poll(), config.pollIntervalMs);
      });
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      await lock.run(async () => {
        const messages = await beeper.listMessages(
          config.beeperChatId,
          config.messageLimit,
        );
        // Newest-first; walk backwards to oldest, inject in chronological
        // order. Skip the bridge's own outbound messages by recorded ID.
        const newMessages: BeeperMessage[] = [];
        for (const message of messages) {
          if (registry.isOwn(message.id)) continue;
          if (lastSeenID !== null && message.id === lastSeenID) break;
          newMessages.unshift(message);
        }
        const newest = newMessages[newMessages.length - 1];
        if (newest) lastSeenID = newest.id;

        for (const message of newMessages) {
          const text = extractText(message);
          if (text) {
            await inject(message.id, text);
            continue;
          }
          // No text: try transcribing an audio attachment (voice note).
          const attachment = firstAudioAttachment(message);
          if (attachment) {
            await handleAudio(message, attachment);
          }
        }
      });
    } catch (err) {
      logger.error(`poll error: ${err}`);
    } finally {
      polling = false;
    }
  }

  async function inject(messageID: string, text: string): Promise<void> {
    // The session is pinned once at startup; sessionRef is only ever
    // written then, so avoid a session.list() on the socket for every poll.
    const sessionID = await resolveSessionID();
    if (!sessionID) {
      logger.info('no active session; skipping injection');
      return;
    }
    await opencode.promptAsync(sessionID, text);
    logger.info(`injected message ${messageID} into session ${sessionID}`);
  }

  async function handleAudio(
    message: BeeperMessage,
    attachment: BeeperAttachment,
  ): Promise<void> {
    logger.info(
      `transcribing audio message ${message.id} (${attachment.fileName ?? attachment.id})`,
    );
    const result = await transcribeAttachment(attachment, logger);
    if (!result) {
      logger.info(`no transcription for message ${message.id}; skipping`);
      return;
    }
    // Post the transcript back to the chat so it's clear what was heard, and
    // record it as own so the poller never re-injects the post itself. The
    // poll already holds the lock, so the record lands before the next poll.
    const formatted = `🎙️ **Transcription** (${result.fileName}):\n\n${result.text}`;
    await beeper.sendMessage(config.beeperChatId, formatted);
    await recordOwnMessage(formatted);
    logger.info(`posted transcription for message ${message.id}`);
    // Inject the transcript into the session as the prompt.
    await inject(message.id, result.text);
  }

  async function resolveSessionID(): Promise<string | null> {
    // The session ID is explicit in the config; the subscription loop sets
    // sessionRef at startup, this is the race fallback until then.
    return sessionRef.id ?? config.opencodeSessionId;
  }

  return { start, stop };
}
