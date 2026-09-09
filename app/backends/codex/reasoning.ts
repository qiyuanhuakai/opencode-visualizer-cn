function reasoningBlocks(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((block): block is string => typeof block === 'string')
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function codexReasoningText(item: Readonly<Record<string, unknown>>): string {
  return reasoningBlocks(item.summary) || reasoningBlocks(item.text) || reasoningBlocks(item.content);
}
