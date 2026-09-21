// A chat message reduced to what the core cares about: identity, plain
// text, and any audio attachments. Adapters map provider messages onto this
// at the boundary.
import type { AudioAttachmentData } from './AudioAttachmentData.js';

export type ChatMessageData = {
  id: string;
  text?: string;
  // Sender identity, when the provider exposes it. isSender === true means
  // the message came from the authenticated account the bridge sends as.
  senderID?: string;
  isSender?: boolean;
  attachments?: AudioAttachmentData[];
};
