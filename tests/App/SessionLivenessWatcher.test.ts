import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionPort } from '../../src/Domain/Ports/SessionPort.js';
import type { LoggerPort } from '../../src/Domain/Ports/LoggerPort.js';
import { SessionLivenessWatcher } from '../../src/App/SessionLivenessWatcher.js';

const INTERVAL_MS = 10;

function makeWatcher(
  active: () => Promise<{ id: string } | null>,
  log: string[],
  stalePolls = 3,
): { watcher: SessionLivenessWatcher; staleCalls: () => number } {
  const session: SessionPort = {
    async getSession() {
      return null;
    },
    async promptAsync() {},
    async getMessage() {
      return null;
    },
    async subscribeEvents() {
      return { close() {}, done: Promise.resolve() };
    },
    getActiveSession: active,
  };
  const logger: LoggerPort = {
    info: (m) => log.push(m),
    debug: () => {},
    error: (m) => log.push(m),
  };
  let calls = 0;
  const watcher = new SessionLivenessWatcher(session, logger, {
    sessionRef: { id: 'ses_pinned' },
    onStale: () => {
      calls += 1;
    },
    intervalMs: INTERVAL_MS,
    stalePolls,
  });
  return { watcher, staleCalls: () => calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionLivenessWatcher', () => {
  it('stays alive while the pinned session is the active one', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { watcher, staleCalls } = makeWatcher(
      async () => ({ id: 'ses_pinned' }),
      log,
    );

    watcher.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 6);

    expect(staleCalls()).toBe(0);
    watcher.stop();
  });

  it('detaches after the configured streak of polls on another active session', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { watcher, staleCalls } = makeWatcher(
      async () => ({ id: 'ses_other' }),
      log,
    );

    watcher.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(staleCalls()).toBe(0);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(staleCalls()).toBe(1);

    // The watcher stopped itself — further ticks change nothing.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(staleCalls()).toBe(1);
    expect(log.some((m) => m.includes('detaching'))).toBe(true);
  });

  it('resets the streak when the pinned session becomes active again', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    let activeID = 'ses_other';
    const { watcher, staleCalls } = makeWatcher(
      async () => ({ id: activeID }),
      log,
    );

    watcher.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    activeID = 'ses_pinned';
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    activeID = 'ses_other';
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    // Two stale polls before the reset, two after — the threshold of three
    // is never reached.
    expect(staleCalls()).toBe(0);
    watcher.stop();
  });

  it('pauses the streak while the socket is unreachable', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { watcher, staleCalls } = makeWatcher(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      log,
    );

    watcher.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);

    expect(staleCalls()).toBe(0);
    watcher.stop();
  });

  it('pauses the streak when no session is active', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { watcher, staleCalls } = makeWatcher(async () => null, log);

    watcher.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);

    expect(staleCalls()).toBe(0);
    watcher.stop();
  });
});
