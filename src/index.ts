// Composition root. The only place that knows concrete adapters: config →
// logger → adapters → domain → actions → driving side. Shuts down cleanly on
// SIGINT/SIGTERM.
import { loadConfig } from './config.js';
import type { LoggerPort } from './Domain/Ports/LoggerPort.js';
import { Mutex } from './Domain/Mutex.js';
import { OwnMessageRegistry } from './Domain/OwnMessageRegistry.js';
import { InjectMessageAction } from './Domain/Actions/InjectMessageAction.js';
import { PostToChatAction } from './Domain/Actions/PostToChatAction.js';

import { RelayVoiceNoteAction } from './Domain/Actions/RelayVoiceNoteAction.js';
import { BeeperMcpAdapter } from './Infrastructure/Beeper/BeeperMcpAdapter.js';
import { OpencodeSocketAdapter } from './Infrastructure/Opencode/OpencodeSocketAdapter.js';
import { VoxtypeAdapter } from './Infrastructure/Voxtype/VoxtypeAdapter.js';
import { InboundPoller } from './App/InboundPoller.js';
import { TurnWatcher } from './App/TurnWatcher.js';

const config = loadConfig();

const logger: LoggerPort = {
  info: (message) => console.log(`[bridge] ${message}`),
  debug: (message) => {
    if (config.debug) console.log(`[bridge] ${message}`);
  },
  error: (message) => console.error(`[bridge] ${message}`),
};

// Adapters (driven side).
const chat = new BeeperMcpAdapter(config.beeperMcpUrl, config.beeperToken);
const session = new OpencodeSocketAdapter(config.opencodeSocketPath, logger);
const transcription = new VoxtypeAdapter(logger);

// Domain.
const mutex = new Mutex();
const registry = new OwnMessageRegistry();
const injectMessage = new InjectMessageAction(session);
const postToChat = new PostToChatAction(
  chat,
  registry,
  mutex,
  logger,
  config.beeperChatId,
  config.messageLimit,
);

const relayVoiceNote = new RelayVoiceNoteAction(
  transcription,
  postToChat,
  injectMessage,
  logger,
);

// Pinned session: the instance name carries the session ID, so the bridge
// attaches to exactly that session and stays there — switching sessions in
// the TUI does not re-target it, and a reconnect re-subscribes to the same
// session instead of re-resolving.
const sessionRef: { id: string | null } = { id: null };

// Driving side.
const inbound = new InboundPoller(
  chat,
  injectMessage,
  relayVoiceNote,
  registry,
  mutex,
  logger,
  {
    chatID: config.beeperChatId,
    pollIntervalMs: config.pollIntervalMs,
    messageLimit: config.messageLimit,
    sessionRef,
    fallbackSessionID: config.opencodeSessionId,
  },
);
const turnWatcher = new TurnWatcher(postToChat, logger, sessionRef);

logger.info(
  `starting: chat=${config.beeperChatId} socket=${config.opencodeSocketPath}`,
);

let shuttingDown = false;
let subscription: { close(): void; done: Promise<void> } | null = null;
let subscribedSessionID: string | null = null;

// Resolve the pinned session, then subscribe to the SSE stream so no
// assistant output is missed. The connection can drop when the TUI restarts
// and recreates the socket — reconnect with a delay, always to the same
// pinned session.
async function subscribeWithRetry(): Promise<void> {
  while (!shuttingDown) {
    try {
      if (sessionRef.id === null) {
        // The session ID comes from the instance name; validate it exists
        // before attaching, and retry with a clear error if it doesn't.
        const existing = await session.getSession(config.opencodeSessionId);
        if (!existing) {
          logger.error(
            `pinned session ${config.opencodeSessionId} not found; retrying in 3s`,
          );
          await sleep(3000);
          continue;
        }
        sessionRef.id = config.opencodeSessionId;
        logger.info(`pinned to session ${sessionRef.id}`);
      }
      const sessionID = sessionRef.id;
      if (sessionID !== subscribedSessionID) {
        if (subscription) {
          subscription.close();
          subscription = null;
        }
        subscribedSessionID = sessionID;
        subscription = await session.subscribeEvents(
          (event) => turnWatcher.handleEvent(event),
          sessionID,
        );
        logger.info(`subscribed to session ${sessionID}`);
      }
      await subscription?.done;
    } catch (err) {
      logger.error(`SSE subscription error: ${err}`);
    }
    if (shuttingDown) break;
    // The connection closed or errored — drop the subscription so the next
    // iteration creates a fresh one. Without this reset the loop re-awaits
    // an already-resolved `done` promise and never actually reconnects.
    subscription = null;
    subscribedSessionID = null;
    logger.info('SSE connection closed; reconnecting in 3s');
    await sleep(3000);
  }
}

void subscribeWithRetry();
inbound.start();

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}; shutting down`);
  inbound.stop();
  turnWatcher.stop();
  if (subscription) subscription.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
