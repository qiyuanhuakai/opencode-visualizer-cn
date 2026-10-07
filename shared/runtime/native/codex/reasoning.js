function reasoningBlocks(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((block) => typeof block === 'string')
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
}
export function codexReasoningText(item) {
  return (
    reasoningBlocks(item.summary) || reasoningBlocks(item.text) || reasoningBlocks(item.content)
  );
}
