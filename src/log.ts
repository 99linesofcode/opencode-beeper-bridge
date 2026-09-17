// Logger.
//
// Single responsibility: emit structured, level-gated log lines. Debug
// output is off by default and enabled with DEBUG=true — the bridge runs as
// a standalone process, so stdout/stderr are safe (unlike the socket plugin,
// which runs inside the TUI).

import { type Config } from './config.js';

export type Logger = {
  info(message: string): void;
  debug(message: string): void;
  error(message: string): void;
};

export function createLogger(config: Config): Logger {
  return {
    info: (message) => console.log(`[bridge] ${message}`),
    debug: (message) => {
      if (config.debug) console.log(`[bridge] ${message}`);
    },
    error: (message) => console.error(`[bridge] ${message}`),
  };
}
