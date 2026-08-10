export type TextTransformer = {
  readonly trigger: string;
  readonly replacement: string;
};

export type TextTransformerApplication = {
  readonly text: string;
  readonly cursor: number;
  readonly replaced: boolean;
};

export type TextTransformerTriggerIssue = 'invalid' | 'duplicate';

type TextTransformerContext = {
  readonly start: number;
  readonly end: number;
  readonly query: string;
};

function normalizeTrigger(value: string): string {
  return value.trim().replace(/^\\+/u, '');
}

function isValidTrigger(value: string): boolean {
  return value.length > 0 && !/[\s\\]/u.test(value);
}

function transformerContext(input: string, cursor: number): TextTransformerContext | null {
  const boundedCursor = Math.max(0, Math.min(cursor, input.length));
  const prefix = input.slice(0, boundedCursor);
  const match = prefix.match(/\\([^\s\\]*)$/u);
  if (!match || match.index === undefined) return null;
  return {
    start: match.index,
    end: boundedCursor,
    query: match[1] ?? '',
  };
}

function transformerByTrigger(
  transformers: readonly TextTransformer[],
  trigger: string,
): TextTransformer | undefined {
  const normalized = trigger.toLocaleLowerCase();
  return transformers.find((item) => item.trigger.toLocaleLowerCase() === normalized);
}

function applyTransformerAtContext(
  input: string,
  context: TextTransformerContext,
  transformer: TextTransformer,
  trailingText: string,
): TextTransformerApplication {
  const prefix = input.slice(0, context.start);
  const suffix = input.slice(context.end);
  const text = `${prefix}${transformer.replacement}${trailingText}${suffix}`;
  return {
    text,
    cursor: prefix.length + transformer.replacement.length + trailingText.length,
    replaced: true,
  };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function normalizeTextTransformers(value: unknown): TextTransformer[] {
  if (!Array.isArray(value)) return [];
  const normalized = new Map<string, TextTransformer>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const rawTrigger = Reflect.get(item, 'trigger');
    const replacement = Reflect.get(item, 'replacement');
    if (typeof rawTrigger !== 'string' || typeof replacement !== 'string') continue;
    const trigger = normalizeTrigger(rawTrigger);
    if (!isValidTrigger(trigger)) continue;
    const key = trigger.toLocaleLowerCase();
    normalized.delete(key);
    normalized.set(key, { trigger, replacement });
  }
  return Array.from(normalized.values());
}

export function getTextTransformerTriggerIssue(
  transformers: readonly TextTransformer[],
  index: number,
): TextTransformerTriggerIssue | null {
  const trigger = transformers[index]?.trigger.trim() ?? '';
  if (!trigger) return null;
  if (/[\s\\]/u.test(trigger)) return 'invalid';
  const normalized = trigger.toLocaleLowerCase();
  const matches = transformers.filter(
    (item) => item.trigger.trim().toLocaleLowerCase() === normalized,
  );
  return matches.length > 1 ? 'duplicate' : null;
}

export function findTextTransformerMatches(
  input: string,
  cursor: number,
  transformers: readonly TextTransformer[],
): TextTransformer[] {
  const context = transformerContext(input, cursor);
  if (!context) return [];
  const query = context.query.toLocaleLowerCase();
  return transformers.filter((item) => item.trigger.toLocaleLowerCase().startsWith(query));
}

export function applyTextTransformerAtCursor(
  input: string,
  cursor: number,
  transformers: readonly TextTransformer[],
  trailingText = '',
): TextTransformerApplication {
  const context = transformerContext(input, cursor);
  if (!context) return { text: input, cursor, replaced: false };
  const transformer = transformerByTrigger(transformers, context.query);
  if (!transformer) return { text: input, cursor, replaced: false };
  return applyTransformerAtContext(input, context, transformer, trailingText);
}

export function applyTextTransformerSelectionAtCursor(
  input: string,
  cursor: number,
  transformer: TextTransformer,
  trailingText = '',
): TextTransformerApplication {
  const context = transformerContext(input, cursor);
  if (!context) return { text: input, cursor, replaced: false };
  const triggerSuffix = transformer.trigger.slice(context.query.length);
  const inputSuffix = input.slice(context.end, context.end + triggerSuffix.length);
  const consumedSuffixLength =
    inputSuffix.toLocaleLowerCase() === triggerSuffix.toLocaleLowerCase()
      ? triggerSuffix.length
      : 0;
  return applyTransformerAtContext(
    input,
    { ...context, end: context.end + consumedSuffixLength },
    transformer,
    trailingText,
  );
}

export function expandTextTransformers(
  input: string,
  transformers: readonly TextTransformer[],
): string {
  const entries = normalizeTextTransformers(transformers).sort(
    (left, right) => right.trigger.length - left.trigger.length,
  );
  if (entries.length === 0) return input;
  const alternatives = entries.map((item) => escapeRegularExpression(item.trigger)).join('|');
  const pattern = new RegExp(`\\\\(${alternatives})(?![\\p{L}\\p{M}\\p{N}\\p{Pc}])`, 'giu');
  return input.replace(pattern, (match, trigger: string) => {
    return transformerByTrigger(entries, trigger)?.replacement ?? match;
  });
}
