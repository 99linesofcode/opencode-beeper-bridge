// UC: a chat message reaches the session as a prompt, without waiting for
// the reply.
import type { SessionPort } from '../Ports/SessionPort.js';

export class InjectMessageAction {
  constructor(private readonly session: SessionPort) {}

  async execute(input: { sessionID: string; text: string }): Promise<void> {
    await this.session.promptAsync(input.sessionID, input.text);
  }
}
