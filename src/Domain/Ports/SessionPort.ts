// The core's need for the session: inject a prompt without waiting for the
// reply, fetch a message's authoritative content, and subscribe to the
// session's event stream scoped to one session. Designed for the core,
// never mimicking opencode's API. The real adapter lives in Infrastructure.
export type SessionEvent = {
  event: string;
  data: unknown;
};

export type SessionSubscription = {
  close(): void;
  done: Promise<void>;
};

export interface SessionPort {
  getSession(sessionID: string): Promise<unknown>;
  getActiveSession(): Promise<{ id: string } | null>;
  promptAsync(sessionID: string, text: string): Promise<void>;
  getMessage(sessionID: string, messageID: string): Promise<unknown>;
  subscribeEvents(
    onEvent: (event: SessionEvent) => void,
    sessionID?: string | null,
  ): Promise<SessionSubscription>;
}
