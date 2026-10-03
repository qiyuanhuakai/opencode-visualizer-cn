import type { AssistantMessageInfo } from '../../types/sse';

export type DshMessageTokens = AssistantMessageInfo['tokens'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function readDshTokenUsage(value: unknown): DshMessageTokens | undefined {
  if (!isRecord(value) || !isCount(value.inputTokens) || !isCount(value.outputTokens)) return undefined;
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
    if (value[key] !== undefined && !isCount(value[key])) return undefined;
  }
  const read = isCount(value.cacheReadTokens) ? value.cacheReadTokens : 0;
  const write = isCount(value.cacheWriteTokens) ? value.cacheWriteTokens : 0;
  const reasoning = isCount(value.reasoningTokens) ? value.reasoningTokens : 0;
  const knownTotal = value.inputTokens + value.outputTokens + read + write;
  if (!Number.isSafeInteger(knownTotal) || reasoning > value.outputTokens) return undefined;
  const total = isCount(value.totalTokens) ? value.totalTokens
    : value.cacheReadTokens !== undefined && value.cacheWriteTokens !== undefined ? knownTotal : undefined;
  if (total !== undefined && (total < knownTotal || (value.cacheReadTokens !== undefined && value.cacheWriteTokens !== undefined && total !== knownTotal))) return undefined;
  return { input: value.inputTokens, output: value.outputTokens, reasoning, cache: { read, write }, ...(total === undefined ? {} : { total }) };
}

export function dshAttemptUsage(data: Record<string, unknown>): DshMessageTokens | undefined {
  if (data.usage !== undefined) return readDshTokenUsage(data.usage);
  const stream = Array.isArray(data.stream) ? data.stream : [];
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const item = stream[index];
    if (isRecord(item) && isRecord(item.chunk) && item.chunk.type === 'usage') return readDshTokenUsage(item.chunk.usage);
  }
  return undefined;
}

export function sumDshAttemptUsage(attempts: ReadonlyMap<number, DshMessageTokens>): DshMessageTokens {
  const tokens: DshMessageTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let total = 0;
  let hasTotal = attempts.size > 0;
  for (const usage of attempts.values()) {
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.reasoning += usage.reasoning;
    tokens.cache.read += usage.cache.read;
    tokens.cache.write += usage.cache.write;
    total += usage.total ?? 0;
    hasTotal &&= usage.total !== undefined;
  }
  if (hasTotal) tokens.total = total;
  return tokens;
}
