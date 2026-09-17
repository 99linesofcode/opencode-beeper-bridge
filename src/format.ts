// Markdown condensation + text normalization.
//
// Single responsibility: turn raw assistant text into a Beeper-friendly
// markdown message — trimmed, blank runs collapsed — and normalize Beeper's
// HTML rendering back to plain text for comparison.

export function formatForBeeper(text: string): string {
  let out = text.trim();
  // Collapse runs of 2+ blank lines to a single blank line.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

// Canonicalize text for own-message correlation: strip Beeper's HTML
// rendering (tags, entities) and the markdown the bridge sends down to the
// same comparable plain text, collapsing whitespace. Both sides of a sent
// message must canonicalize identically.
export function canonicalize(text: string): string {
  let out = text;
  // HTML side (Beeper's rendering of a received message).
  out = out.replace(/<br\s*\/?>/gi, ' ');
  out = out.replace(/<\/p>|<\/h[1-6]>|<\/li>|<\/blockquote>/gi, ' ');
  out = out.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1');
  out = out.replace(/<[^>]+>/g, '');
  out = out.replace(/&amp;/g, '&');
  out = out.replace(/&lt;/g, '<');
  out = out.replace(/&gt;/g, '>');
  out = out.replace(/&quot;/g, '"');
  out = out.replace(/&#39;/g, "'");
  out = out.replace(/&nbsp;/g, ' ');
  // Markdown side (what the bridge sends).
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/~~([^~]+)~~/g, '$1');
  out = out.replace(/(^|\s)\*([^*\s][^*]*?[^*\s])\*(?=\s|$)/g, '$1$2');
  out = out.replace(/(^|\s)_([^_\s][^_]*?[^_\s])_(?=\s|$)/g, '$1$2');
  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/^\s*\d+[.)]\s+/gm, '');
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1');
  // Collapse whitespace.
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}
