// The core's need for voice transcription: resolve an audio attachment to
// text. The mechanics (download, decrypt, convert, transcribe) live in the
// adapter.
import type { AudioAttachmentData } from '../DataTransferObjects/AudioAttachmentData.js';
import type { TranscriptionData } from '../DataTransferObjects/TranscriptionData.js';

export interface TranscriptionPort {
  transcribe(
    attachment: AudioAttachmentData,
  ): Promise<TranscriptionData | null>;
}
