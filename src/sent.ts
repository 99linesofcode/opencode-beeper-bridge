// Own-message registry.
//
// Single responsibility: remember the message IDs of messages the bridge
// itself sent to Beeper, so the inbound poller never re-injects them as user
// input. The outbound consumer records each sent message's ID; the inbound
// poller skips any message whose ID is in this set.

export type SentRegistry = {
  markOwn(id: string): void;
  isOwn(id: string): boolean;
};

export function createSentRegistry(): SentRegistry {
  const ownIDs = new Set<string>();
  return {
    markOwn(id) {
      ownIDs.add(id);
    },
    isOwn(id) {
      return ownIDs.has(id);
    },
  };
}
