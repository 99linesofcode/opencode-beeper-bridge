// Async mutex.
//
// Single responsibility: serialize critical sections across the bridge's
// concurrent loops. The outbound consumer and inbound poller share one lock so
// a message the bridge sends is recorded as own before the poller can ever
// list it — eliminating the race where the bridge re-injects its own reply.

export type Lock = {
  run<T>(fn: () => Promise<T>): Promise<T>;
};

export function createLock(): Lock {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const prev = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => (release = resolve));
      return prev.then(() => fn()).finally(release);
    },
  };
}
