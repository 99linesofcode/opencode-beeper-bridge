# @99linesofcode/opencode-beeper-bridge

Bridge Beeper messages to a specific opencode session over the socket plugin's
Unix socket. Each bridge instance attaches one chat to one session.

- **Inbound:** a message sent to the configured Beeper chat (default: the
  WhatsApp self-DM, chatID `5000`) becomes a user message in the pinned
  opencode session. Voice notes are transcribed locally (ffmpeg → voxtype)
  and the transcript is injected as the prompt, with the transcription posted
  back to the chat. Both `file://` and encrypted `mxc://` attachments are
  handled — `mxc://` is downloaded from the Matrix media server and decrypted
  with AES-256-CTR using the key/IV embedded in the attachment metadata.
- **Outbound:** assistant output in the pinned session streams back to the
  chat as each text part is produced (debounced so a streaming part posts
  once with its complete text) — live progress, not one summary at the end.

## Requirements

- The [opencode socket plugin](https://github.com/99linesofcode/opencode-socket-plugin)
  must be loaded (it binds the Unix socket the bridge talks to).
- The Beeper desktop app must be running (it hosts the local MCP server the
  bridge talks to).
- `ffmpeg` and `voxtype` on `PATH` for voice-note transcription.

## Install

```bash
bun install
```

## Usage

```bash
BEEPER_TOKEN=bdapi_... bun run src/index.ts
```

Configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BEEPER_TOKEN` | — (required) | Beeper API token (Bearer) for the local MCP server |
| `BEEPER_MCP_URL` | `http://localhost:23373/v0/mcp` | Local Beeper MCP server |
| `BEEPER_CHAT_ID` | `5000` | Chat to watch and post to; may carry the session as `<chatId>:<sessionId>` |
| `OPENCODE_SESSION_ID` | — (required) | Session to attach to; wins over the `BEEPER_CHAT_ID` suffix |
| `OPENCODE_SOCKET_PATH` | `$XDG_RUNTIME_DIR/opencode.sock` | Socket plugin's Unix socket |
| `POLL_INTERVAL_MS` | `5000` | Inbound poll interval |
| `DEBUG` | `false` | Log every SSE event (debugging aid) |

## How it works

```
Beeper chat ◄──► bridge (Bun process) ◄──► opencode TUI + socket plugin
```

- The bridge polls the chat via the Beeper MCP server (JSON-RPC over HTTP,
  Bearer auth), injects new messages into the session via
  `POST /session/:id/prompt_async`, and subscribes to the socket's SSE stream
  (`GET /event`) and posts each assistant text part as it is produced —
  debounced so a streaming part posts once with its complete text; the turn
  end (idle) is only a safety net to flush parts still streaming.

## Multiple bridges

Each bridge instance attaches one chat to one session. The instance name is
`<chatId>:<sessionId>` — the session ID is passed explicitly, so several
bridges can run at once, each pinned to its own session:

```bash
systemctl --user start opencode-beeper-bridge@7239:ses_f8471dc76ffeM1W4mMYvyDsvtA
systemctl --user start opencode-beeper-bridge@6148:ses_anotherSessionId
```

The session ID can also be set via the `OPENCODE_SESSION_ID` environment
variable; it wins over the instance suffix. One of the two is required — the
bridge fails fast at startup if neither is present.

## Notes

- **Attach / detach lifecycle:** starting the bridge attaches the chat to the
  session named in the instance. Stopping the bridge detaches it. Switching
  sessions in the TUI while attached does not re-target the bridge.
- The bridge skips messages it sent itself (tracked by message ID) so the
  assistant's replies are never re-injected as prompts.
- The inbound cursor is seeded at startup from the newest message — history is
  not replayed.
- The socket lives and dies with the opencode process. No TUI running, no
  socket, no bridge.

## Development

```bash
bun install       # install dependencies
bun run dev       # run the bridge from source
bun run build     # compile TypeScript to build/
bun run test      # run the test suite once
bun run test:watch # run the test suite in watch mode
bun run lint      # eslint (flat config + prettier)
bun run typecheck # type-check without emitting
bun run audit     # check dependencies for known vulnerabilities
```

## Contributing

Please review the [Contribution Guidelines](https://github.com/99linesofcode/.github/blob/main/.github/CONTRIBUTING.md).

## Code of conduct

In order to ensure that the community is welcoming to all, please review and abide by the [Code of Conduct](https://github.com/99linesofcode/.github?tab=coc-ov-file).

## Security vulnerabilities

Please review the [security policy](https://github.com/99linesofcode/.github?tab=security-ov-file) on how to report security vulnerabilities.

## License

This software is open source and licensed under the [MIT license](https://github.com/99linesofcode/.github?tab=MIT-1-ov-file).