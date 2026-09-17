import { describe, expect, it } from 'vitest';
import { canonicalize, formatForBeeper } from '../src/format.js';

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

  it('canonicalizes the sent and rendered sides identically', () => {
    // The contract the echo guard depends on: what the bridge sends down
    // (markdown) and what Beeper renders back (HTML) must compare equal.
    const markdown =
      '# Title\n\nSome **bold** text with [a link](https://x) and `code`.\n\n- one\n- two';
    const html =
      '<h1>Title</h1><p>Some <b>bold</b> text with <a href="https://x">a link</a> and <code>code</code>.</p><ul><li>one</li><li>two</li></ul>';

    const sentSide = canonicalize(formatForBeeper(markdown));
    const renderedSide = canonicalize(html);

    expect(sentSide).toBe(renderedSide);
  });
});
