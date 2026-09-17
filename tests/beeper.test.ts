import { describe, expect, it } from 'vitest';
import { extractText } from '../src/beeper.js';

describe('extractText', () => {
  it('returns the text of a text message', () => {
    const text = extractText({ id: 'm1', text: 'hello' });

    expect(text).toBe('hello');
  });

  it('returns undefined for whitespace-only text', () => {
    const text = extractText({ id: 'm1', text: '   ' });

    expect(text).toBeUndefined();
  });

  it('returns undefined for a message without text', () => {
    const text = extractText({ id: 'm1' });

    expect(text).toBeUndefined();
  });
});
