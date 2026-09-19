// An audio attachment reduced to what the core cares about: identity, a
// display name, and a resolvable source URL.
export type AudioAttachmentData = {
  id: string;
  fileName?: string;
  srcURL?: string;
};
