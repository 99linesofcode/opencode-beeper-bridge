// Remembers the message IDs the bridge itself sent to the chat, so the
// inbound poller never re-injects them as user input. The send-and-record
// path marks each ID; the poll skips anything in this set.
export class OwnMessageRegistry {
  private readonly ownIDs = new Set<string>();

  markOwn(id: string): void {
    this.ownIDs.add(id);
  }

  isOwn(id: string): boolean {
    return this.ownIDs.has(id);
  }
}
