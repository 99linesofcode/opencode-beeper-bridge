// The part of a finished turn worth sending to the chat: the closing
// summary. A turn's parts stream in order — opening text, tool calls,
// mid-work commentary, and finally the summary. The summary is the last
// contiguous run of text parts: everything before it is intermediate. A turn
// that ends on a tool falls back to the text run that preceded it.
type MessagePart = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export function summaryFromParts(
  parts: MessagePart[] | undefined,
): string | undefined {
  const list = parts ?? [];

  let lastTextIndex = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.type === 'text') {
      lastTextIndex = i;
      break;
    }
  }
  if (lastTextIndex === -1) return undefined;

  const run: string[] = [];
  for (let i = lastTextIndex; i >= 0; i--) {
    const part = list[i]!;
    if (part.type === 'tool') break;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      run.unshift(part.text);
    }
  }
  return run.length > 0 ? run.join('\n') : undefined;
}
