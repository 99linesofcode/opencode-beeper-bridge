// UC: a voice note is transcribed, the transcript is shown in the chat, and
// the text is injected into the session as the prompt.
import type { TranscriptionPort } from '../Ports/TranscriptionPort.js';
import type { LoggerPort } from '../Ports/LoggerPort.js';
import type { AudioAttachmentData } from '../DataTransferObjects/AudioAttachmentData.js';
import type { InjectMessageAction } from './InjectMessageAction.js';
import type { PostToChatAction } from './PostToChatAction.js';

export class RelayVoiceNoteAction {
  constructor(
    private readonly transcription: TranscriptionPort,
    private readonly postToChat: PostToChatAction,
    private readonly injectMessage: InjectMessageAction,
    private readonly logger: LoggerPort,
  ) {}

  async execute(input: {
    sessionID: string;
    attachment: AudioAttachmentData;
  }): Promise<void> {
    const result = await this.transcription.transcribe(input.attachment);
    if (!result) {
      this.logger.info('no transcription; skipping');
      return;
    }
    await this.postToChat.execute(
      `🎙️ **Transcription** (${result.fileName}):\n\n${result.text}`,
    );
    await this.injectMessage.execute({
      sessionID: input.sessionID,
      text: result.text,
    });
  }
}
