// Environment configuration.
//
// Single responsibility: turn environment variables into the one Config
// object the rest of the bridge consumes. Pure function — no I/O, no state.

import path from 'node:path';

export type Config = {
  beeperToken: string;
  beeperMcpUrl: string;
  beeperChatId: string;
  opencodeSessionId: string;
  opencodeSocketPath: string;
  pollIntervalMs: number;
  messageLimit: number;
  debug: boolean;
};

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const beeperToken = env.BEEPER_TOKEN;
  if (!beeperToken) {
    throw new Error('BEEPER_TOKEN is required (set it or export it)');
  }

  const runtime = env.XDG_RUNTIME_DIR;
  // || rather than ?? so an empty value still falls through instead of
  // producing an empty or relative socket path.
  const opencodeSocketPath =
    env.OPENCODE_SOCKET_PATH || path.join(runtime || '/tmp', 'opencode.sock');

  // The instance name carries the session to attach to: "<chatId>:<sessionId>".
  // An explicit OPENCODE_SESSION_ID wins over the instance suffix.
  const [beeperChatId = '5000', sessionFromInstance] = (
    env.BEEPER_CHAT_ID ?? '5000'
  ).split(':', 2);
  const opencodeSessionId = env.OPENCODE_SESSION_ID || sessionFromInstance;
  if (!opencodeSessionId) {
    throw new Error(
      'OPENCODE_SESSION_ID is required (set it or use opencode-beeper-bridge@<chatId>:<sessionId>)',
    );
  }

  return {
    beeperToken,
    beeperMcpUrl: env.BEEPER_MCP_URL ?? 'http://localhost:23373/v0/mcp',
    beeperChatId,
    opencodeSessionId,
    opencodeSocketPath,
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 5000),
    // 20 covers any realistic burst between polls; the walk-back breaks at
    // the last-seen cursor, so older messages are never re-read anyway.
    messageLimit: Number(env.MESSAGE_LIMIT ?? 20),
    debug: env.DEBUG === 'true' || env.DEBUG === '1',
  };
}
