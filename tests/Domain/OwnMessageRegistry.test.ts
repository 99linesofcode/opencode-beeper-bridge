import { describe, expect, it } from 'vitest';
import { OwnMessageRegistry } from '../../src/Domain/OwnMessageRegistry.js';

describe('OwnMessageRegistry', () => {
  it('recognizes a marked message as own', () => {
    const registry = new OwnMessageRegistry();

    registry.markOwn('msg_1');

    expect(registry.isOwn('msg_1')).toBe(true);
  });

  it('does not recognize unmarked messages as own', () => {
    const registry = new OwnMessageRegistry();
    registry.markOwn('msg_1');

    const own = registry.isOwn('msg_2');

    expect(own).toBe(false);
  });

  it('recognizes a recently-sent text as own even without an ID', () => {
    const registry = new OwnMessageRegistry();

    registry.markSentText('Here is my long reply to the user.');

    expect(registry.isOwnText('Here is my long reply to the user.')).toBe(true);
  });

  it('does not treat an unrelated text as own', () => {
    const registry = new OwnMessageRegistry();
    registry.markSentText('Here is my long reply to the user.');

    expect(registry.isOwnText('A completely different user message')).toBe(false);
  });

  it('bounds the recent-text list so old sends stop matching', () => {
    const registry = new OwnMessageRegistry();
    for (let i = 0; i < 60; i++) registry.markSentText(`message ${i}`);

    expect(registry.isOwnText('message 0')).toBe(false);
    expect(registry.isOwnText('message 59')).toBe(true);
  });
});
