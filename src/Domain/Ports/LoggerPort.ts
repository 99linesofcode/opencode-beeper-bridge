// The core's need for level-gated logging: info always, debug only when
// enabled, errors to stderr.
export interface LoggerPort {
  info(message: string): void;
  debug(message: string): void;
  error(message: string): void;
}
