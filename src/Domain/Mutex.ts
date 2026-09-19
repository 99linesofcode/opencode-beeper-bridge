// Async mutex. Serializes critical sections across concurrent loops: the
// send-and-record path and the inbound poll share one lock so a sent message
// is recorded as own before any poll can list it.
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    return prev.then(() => fn()).finally(release);
  }
}
