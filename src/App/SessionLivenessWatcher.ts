// Driving side: watches which session the TUI is actually working in and
// ends the bridge when its pinned session has been abandoned — the user
// switched to another session and never came back. Without this, a stale
// bridge keeps injecting prompts into a dead conversation until someone
// notices. The instance name carries the pinned session; the socket's
// /session/active carries the truth about which session is live.
import type { LoggerPort } from '../Domain/Ports/LoggerPort.js';
import type { SessionPort } from '../Domain/Ports/SessionPort.js';

export type SessionLivenessWatcherOptions = {
  sessionRef: { id: string | null };
  onStale: () => void;
  intervalMs: number;
  stalePolls: number;
};

export class SessionLivenessWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private staleCount = 0;
  private checking = false;

  constructor(
    private readonly session: SessionPort,
    private readonly logger: LoggerPort,
    private readonly options: SessionLivenessWatcherOptions,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.checking) return;
    const sessionID = this.options.sessionRef.id;
    if (!sessionID) return;
    this.checking = true;
    try {
      const active = await this.session.getActiveSession();
      if (active === null || active.id === sessionID) {
        this.staleCount = 0;
        return;
      }
      this.staleCount += 1;
      if (this.staleCount < this.options.stalePolls) return;
      this.logger.info(
        `pinned session ${sessionID} not the active session for ${this.staleCount} checks; detaching`,
      );
      this.stop();
      this.options.onStale();
    } catch (err) {
      // No definitive answer (socket down, TUI restarting) — pause the
      // streak so a restart is never misread as abandonment.
      this.logger.error(`liveness check failed: ${err}`);
    } finally {
      this.checking = false;
    }
  }
}
