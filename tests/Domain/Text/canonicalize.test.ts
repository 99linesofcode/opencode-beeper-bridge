import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../../src/Domain/Text/canonicalize.js';

describe('canonicalize', () => {
  it('strips HTML tags and decodes entities', () => {
    const html = canonicalize('<p>Hello <b>world</b></p>');
    const lineBreak = canonicalize('a<br>b');
    const entities = canonicalize('&amp; &lt; &gt; &quot; &#39;');

    expect(html).toBe('Hello world');
    expect(lineBreak).toBe('a b');
    expect(entities).toBe(`& < > " '`);
  });

  it('keeps the alt text of images', () => {
    const canonical = canonicalize('<img src="x.png" alt="photo">');

    expect(canonical).toBe('photo');
  });

  it('strips markdown emphasis, links, code, headings and lists', () => {
    const link = canonicalize('[text](https://x)');
    const image = canonicalize('![alt](https://x.png)');
    const code = canonicalize('`code`');
    const bold = canonicalize('**bold** and __bold__');
    const strike = canonicalize('~~gone~~');
    const heading = canonicalize('# Heading');
    const bullet = canonicalize('- item');
    const numbered = canonicalize('1. item');
    const quote = canonicalize('> quoted');

    expect(link).toBe('text');
    expect(image).toBe('alt');
    expect(code).toBe('code');
    expect(bold).toBe('bold and bold');
    expect(strike).toBe('gone');
    expect(heading).toBe('Heading');
    expect(bullet).toBe('item');
    expect(numbered).toBe('item');
    expect(quote).toBe('quoted');
  });

  it('collapses whitespace', () => {
    const canonical = canonicalize('a\n\n  b\tc');

    expect(canonical).toBe('a b c');
  });
});
