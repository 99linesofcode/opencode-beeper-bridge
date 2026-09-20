import { describe, expect, it } from 'vitest';
import { summaryFromParts } from '../../src/Domain/summaryFromParts.js';

describe('summaryFromParts', () => {
  it('returns only the text after the last tool call — the closing summary', () => {
    const summary = summaryFromParts([
      { type: 'text', text: 'Let me look at this.' },
      { type: 'tool', state: { status: 'completed' } },
      { type: 'text', text: 'Found the culprit.' },
      { type: 'tool', state: { status: 'completed' } },
      { type: 'text', text: 'All fixed. Here is the summary.' },
    ]);

    expect(summary).toBe('All fixed. Here is the summary.');
  });

  it('joins a multi-part closing section', () => {
    const summary = summaryFromParts([
      { type: 'tool', state: { status: 'completed' } },
      { type: 'text', text: 'First paragraph.' },
      { type: 'text', text: 'Second paragraph.' },
    ]);

    expect(summary).toBe('First paragraph.\nSecond paragraph.');
  });

  it('returns the whole text for a tool-free turn', () => {
    const summary = summaryFromParts([
      { type: 'text', text: 'Plain answer.' },
    ]);

    expect(summary).toBe('Plain answer.');
  });

  it('falls back to the last text run when the turn ends on a tool', () => {
    const summary = summaryFromParts([
      { type: 'text', text: 'Running the check now.' },
      { type: 'tool', state: { status: 'completed' } },
    ]);

    expect(summary).toBe('Running the check now.');
  });

  it('returns undefined for a turn with no text at all', () => {
    expect(summaryFromParts([{ type: 'tool', state: { status: 'completed' } }])).toBeUndefined();
  });
});
