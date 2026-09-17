import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('throws without BEEPER_TOKEN', () => {
    expect(() => loadConfig({ OPENCODE_SESSION_ID: 'ses_1' })).toThrow(
      'BEEPER_TOKEN is required',
    );
  });

  it('splits the instance name into chat and session', () => {
    const config = loadConfig({
      BEEPER_TOKEN: 't',
      BEEPER_CHAT_ID: '7239:ses_abc',
    });

    expect(config.beeperChatId).toBe('7239');
    expect(config.opencodeSessionId).toBe('ses_abc');
  });

  it('prefers an explicit OPENCODE_SESSION_ID over the instance suffix', () => {
    const config = loadConfig({
      BEEPER_TOKEN: 't',
      BEEPER_CHAT_ID: '7239:ses_from_instance',
      OPENCODE_SESSION_ID: 'ses_explicit',
    });

    expect(config.opencodeSessionId).toBe('ses_explicit');
  });

  it('throws without a session from env or instance', () => {
    expect(() => loadConfig({ BEEPER_TOKEN: 't' })).toThrow(
      'OPENCODE_SESSION_ID is required',
    );
  });

  it('defaults the chat to the WhatsApp self-DM', () => {
    const config = loadConfig({
      BEEPER_TOKEN: 't',
      OPENCODE_SESSION_ID: 'ses_1',
    });

    expect(config.beeperChatId).toBe('5000');
  });

  it('prefers the socket path env var over the XDG fallback', () => {
    const config = loadConfig({
      BEEPER_TOKEN: 't',
      OPENCODE_SESSION_ID: 'ses_1',
      OPENCODE_SOCKET_PATH: '/custom/opencode.sock',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });

    expect(config.opencodeSocketPath).toBe('/custom/opencode.sock');
  });

  it('falls back to XDG_RUNTIME_DIR for the socket path', () => {
    const config = loadConfig({
      BEEPER_TOKEN: 't',
      OPENCODE_SESSION_ID: 'ses_1',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });

    expect(config.opencodeSocketPath).toBe('/run/user/1000/opencode.sock');
  });

  it('falls through to /tmp on an empty XDG_RUNTIME_DIR', () => {
    const config = loadConfig({
      BEEPER_TOKEN: 't',
      OPENCODE_SESSION_ID: 'ses_1',
      XDG_RUNTIME_DIR: '',
    });

    expect(config.opencodeSocketPath).toBe('/tmp/opencode.sock');
  });

  it('parses numeric and boolean settings', () => {
    const config = loadConfig({
      BEEPER_TOKEN: 't',
      OPENCODE_SESSION_ID: 'ses_1',
      POLL_INTERVAL_MS: '250',
      MESSAGE_LIMIT: '5',
      DEBUG: '1',
    });

    expect(config.pollIntervalMs).toBe(250);
    expect(config.messageLimit).toBe(5);
    expect(config.debug).toBe(true);
  });

  it('enables debug output for DEBUG=true', () => {
    const config = loadConfig({
      BEEPER_TOKEN: 't',
      OPENCODE_SESSION_ID: 'ses_1',
      DEBUG: 'true',
    });

    expect(config.debug).toBe(true);
  });
});
