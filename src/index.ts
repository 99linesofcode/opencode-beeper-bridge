// @99linesofcode/opencode-beeper-bridge
//
// Composition root. Wires the pieces together: loads config, builds the
// logger, the Beeper MCP client and the opencode socket client, starts the
// inbound poller and the outbound SSE consumer, and shuts down cleanly on
// SIGINT/SIGTERM.

import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createBeeperClient } from './beeper.js';
import { createOpencodeClient, type SseSubscription } from './socket.js';
import { createSentRegistry } from './sent.js';
import { createLock } from './lock.js';
import { createInboundPoller } from './inbound.js';
import { createOutboundConsumer } from './outbound.js';

const config = loadConfig();
const logger = createLogger(config);

const beeper = createBeeperClient(config);
const opencode = createOpencodeClient(config, logger);

// Own-message registry + shared lock: the outbound consumer records the IDs
// of messages it sent (under the lock), and the inbound poller skips those by
// ID (under the same lock) — so a sent message is never re-injected.
const registry = createSentRegistry();
const lock = createLock();

// Pinned session: the instance name carries the session ID, so the bridge
// attaches to exactly that session and stays there — switching sessions in
// the TUI does not re-target it, and a reconnect re-subscribes to the same
// session instead of re-resolving.
const sessionRef: { id: string | null } = { id: null };

// The SSE subscription is scoped to the pinned session (?session=), so the
// stream only ever carries events for that session.
let subscription: SseSubscription | null = null;
let subscribedSessionID: string | null = null;

const outbound = createOutboundConsumer(
  config,
  beeper,
  opencode,
  logger,
  registry,
  lock,
  sessionRef,
);
const inbound = createInboundPoller(
  config,
  beeper,
  opencode,
  logger,
  registry,
  lock,
  sessionRef,
);

logger.info(
  `starting: chat=${config.beeperChatId} socket=${config.opencodeSocketPath}`,
);

let shuttingDown = false;

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
        const session = await opencode.getSession(config.opencodeSessionId);
        if (!session) {
          logger.error(
            `pinned session ${config.opencodeSessionId} not found; retrying in 3s`,
          );
          await new Promise((resolve) => setTimeout(resolve, 3000));
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
        subscription = await opencode.subscribeEvents(
          (event) => outbound.handleEvent(event),
          sessionID,
        );
        logger.info(`subscribed to session ${sessionID}`);
      }
      await subscription?.done;
    } catch (err) {
      logger.error(`SSE subscription error: ${err}`);
    }
    if (shuttingDown) break;
    logger.info('SSE connection closed; reconnecting in 3s');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

void subscribeWithRetry();

inbound.start();

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}; shutting down`);
  inbound.stop();
  outbound.stop();
  if (subscription) subscription.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
