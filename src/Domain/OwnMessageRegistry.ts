// Remembers the message IDs the bridge itself sent to the chat, so the
// inbound poller never re-injects them as user input. The send-and-record
// path marks each ID; the poll skips anything in this set.
//
// ID correlation can fail under rapid streaming: Beeper's list_messages may
// not surface a just-sent message within the correlation window, so the ID
// is never recorded and the poller would re-inject the bridge's own post.
// To close that gap, the registry also tracks the *texts* of recent sends;
// the poller skips any message whose text matches a recently-sent text, even
// when the ID was never recorded.
import { isOwnMessage } from './OwnMessages/isOwnMessage.js';

export class OwnMessageRegistry {
  private readonly ownIDs = new Set<string>();
  private readonly recentTexts: string[] = [];
  private static readonly MAX_RECENT = 50;

  markOwn(id: string): void {
    this.ownIDs.add(id);
  }

  markSentText(text: string): void {
    this.recentTexts.push(text);
    if (this.recentTexts.length > OwnMessageRegistry.MAX_RECENT) {
      this.recentTexts.shift();
    }
  }

  isOwn(id: string): boolean {
    return this.ownIDs.has(id);
  }

  isOwnText(text: string): boolean {
    return this.recentTexts.some((sent) => isOwnMessage(sent, text));
  }
}
