import { describe, expect, it } from 'vitest';
import { createSentRegistry } from '../src/sent.js';

describe('createSentRegistry', () => {
  it('recognizes a marked message as own', () => {
    const registry = createSentRegistry();

    registry.markOwn('msg_1');

    expect(registry.isOwn('msg_1')).toBe(true);
  });

  it('does not recognize unmarked messages as own', () => {
    const registry = createSentRegistry();
    registry.markOwn('msg_1');

    const own = registry.isOwn('msg_2');

    expect(own).toBe(false);
  });
});
