import { describe, expect, it } from 'vitest';
import { formatForBeeper } from '../../../src/Domain/Text/formatForBeeper.js';

describe('formatForBeeper', () => {
  it('trims and collapses blank-line runs', () => {
    const formatted = formatForBeeper('\n\nhello\n\n\n\nworld\n\n');

    expect(formatted).toBe('hello\n\nworld');
  });

  it('leaves single blank lines alone', () => {
    const formatted = formatForBeeper('a\n\nb');

    expect(formatted).toBe('a\n\nb');
  });
});
