// Turn raw assistant text into a Beeper-friendly markdown message: trimmed,
// blank runs collapsed.
export function formatForBeeper(text: string): string {
  const out = text.trim();
  return out.replace(/\n{3,}/g, '\n\n');
}
