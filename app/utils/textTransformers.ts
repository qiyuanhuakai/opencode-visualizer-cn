import {
  isValidTextTransformerTrigger,
  normalizeTextTransformers,
  type TextTransformer,
  type TextTransformerInput,
} from './snippets';

export { normalizeTextTransformers, textTransformerTriggerKey } from './snippets';
export type { TextTransformer, TextTransformerInput } from './snippets';

export type TextTransformerApplication = {
  readonly text: string;
  readonly cursor: number;
  readonly replaced: boolean;
};

export type TextTransformerVariables = {
  readonly now?: Date;
  readonly uuid?: () => string;
  readonly clipboard?: string;
  readonly activeFile?: string;
  readonly cwd?: string;
  readonly selection?: string;
};

export type TextTransformerTriggerIssue = 'invalid' | 'duplicate';

type TextTransformerContext = {
  readonly start: number;
  readonly end: number;
};

type ResolvedTextTransformerBody = {
  readonly text: string;
  readonly cursor: number;
  readonly cursorFromMarker: boolean;
};

export const MAX_TEXT_TRANSFORMER_MATCHES = 20;
export const MAX_RESOLVED_TEXT_TRANSFORMER_BODY_LENGTH = 1024 * 1024;

const DYNAMIC_VARIABLE_PATTERN =
  /\{(cursor|date|time|datetime|uuid|clipboard|activeFile|cwd|selection)\}/gu;
type TextDynamicVariable = Exclude<
  keyof TextTransformerVariables,
  'now'
> | 'date' | 'time' | 'datetime';

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function localDate(now: Date): string {
  return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
}

function localTime(now: Date): string {
  return `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}`;
}

function dynamicVariableResolvers(
  variables: TextTransformerVariables,
  now: Date,
): Record<TextDynamicVariable, () => string> {
  return {
    date: () => localDate(now),
    time: () => localTime(now),
    datetime: () => `${localDate(now)} ${localTime(now)}`,
    uuid: variables.uuid ?? (() => globalThis.crypto.randomUUID()),
    clipboard: () => variables.clipboard ?? '',
    activeFile: () => variables.activeFile ?? '',
    cwd: () => variables.cwd ?? '',
    selection: () => variables.selection ?? '',
  };
}

function appendResolvedChunk(chunks: string[], value: string, outputLength: number): number | null {
  if (outputLength > MAX_RESOLVED_TEXT_TRANSFORMER_BODY_LENGTH - value.length) return null;
  chunks.push(value);
  return outputLength + value.length;
}

function resolveTextTransformerBody(
  body: string,
  variables: TextTransformerVariables = {},
): ResolvedTextTransformerBody | null {
  const now = variables.now ?? new Date();
  const variableResolvers = dynamicVariableResolvers(variables, now);
  const chunks: string[] = [];
  let sourceCursor = 0;
  let outputLength = 0;
  let desiredCursor: number | null = null;
  for (const match of body.matchAll(DYNAMIC_VARIABLE_PATTERN)) {
    const index = match.index;
    const token = match[1] as TextDynamicVariable | 'cursor';
    const prefix = body.slice(sourceCursor, index);
    const prefixedLength = appendResolvedChunk(chunks, prefix, outputLength);
    if (prefixedLength === null) return null;
    outputLength = prefixedLength;
    if (token === 'cursor') {
      desiredCursor ??= outputLength;
    } else {
      const value = variableResolvers[token]();
      const resolvedLength = appendResolvedChunk(chunks, value, outputLength);
      if (resolvedLength === null) return null;
      outputLength = resolvedLength;
    }
    sourceCursor = index + match[0].length;
  }
  const suffix = body.slice(sourceCursor);
  const finalLength = appendResolvedChunk(chunks, suffix, outputLength);
  if (finalLength === null) return null;
  return {
    text: chunks.join(''),
    cursor: desiredCursor ?? finalLength,
    cursorFromMarker: desiredCursor !== null,
  };
}

function isIdentifierCharacter(value: string): boolean {
  return /[\p{L}\p{M}\p{N}\p{Pc}]/u.test(value);
}

export function textTransformerSequence(transformer: TextTransformer): string {
  const firstCharacter = String.fromCodePoint(transformer.trigger.codePointAt(0) ?? 0);
  return isIdentifierCharacter(firstCharacter)
    ? `\\${transformer.trigger}`
    : transformer.trigger;
}

function sequencePrefixLength(sequence: string): number {
  let length = 0;
  for (const character of sequence) {
    if (isIdentifierCharacter(character)) break;
    length += character.length;
  }
  return Math.max(1, length);
}

function hasSameText(left: string, right: string): boolean {
  return new RegExp(`^${escapeRegularExpression(left)}$`, 'iu').test(right);
}

function hasValidStartBoundary(input: string, start: number): boolean {
  if (start === 0) return true;
  const previousCodeUnit = input.charCodeAt(start - 1);
  const previousStart =
    previousCodeUnit >= 0xdc00 &&
    previousCodeUnit <= 0xdfff &&
    start > 1 &&
    input.charCodeAt(start - 2) >= 0xd800 &&
    input.charCodeAt(start - 2) <= 0xdbff
      ? start - 2
      : start - 1;
  return !isIdentifierCharacter(input.slice(previousStart, start));
}

function transformerContext(
  input: string,
  cursor: number,
  transformer: TextTransformer,
): TextTransformerContext | null {
  const boundedCursor = Math.max(0, Math.min(cursor, input.length));
  const sequence = textTransformerSequence(transformer);
  const minimumLength = sequencePrefixLength(sequence);
  for (let length = sequence.length; length >= minimumLength; length -= 1) {
    const start = boundedCursor - length;
    if (start < 0 || !hasValidStartBoundary(input, start)) continue;
    if (hasSameText(input.slice(start, boundedCursor), sequence.slice(0, length))) {
      return { start, end: boundedCursor };
    }
  }
  return null;
}

function transformerBySequence(
  transformers: readonly TextTransformer[],
  sequence: string,
): TextTransformer | undefined {
  return transformers.find((item) => hasSameText(textTransformerSequence(item), sequence));
}

function applyTransformerAtContext(
  input: string,
  context: TextTransformerContext,
  transformer: TextTransformer,
  trailingText: string,
  variables: TextTransformerVariables,
): TextTransformerApplication {
  const prefix = input.slice(0, context.start);
  const suffix = input.slice(context.end);
  const body = resolveTextTransformerBody(transformer.body, variables);
  if (!body) return { text: input, cursor: context.end, replaced: false };
  const text = `${prefix}${body.text}${trailingText}${suffix}`;
  return {
    text,
    cursor: prefix.length + body.cursor + (body.cursorFromMarker ? 0 : trailingText.length),
    replaced: true,
  };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function getTextTransformerTriggerIssue(
  transformers: readonly TextTransformerInput[],
  index: number,
): TextTransformerTriggerIssue | null {
  const trigger = transformers[index]?.trigger.trim() ?? '';
  if (!trigger) return null;
  const normalizedTrigger = trigger.replace(/^\\+/u, '');
  if (!isValidTextTransformerTrigger(normalizedTrigger)) return 'invalid';
  const matches = transformers.filter((item) =>
    hasSameText(item.trigger.trim().replace(/^\\+/u, ''), normalizedTrigger),
  );
  return matches.length > 1 ? 'duplicate' : null;
}

export function findTextTransformerMatches(
  input: string,
  cursor: number,
  transformers: readonly TextTransformerInput[],
): TextTransformer[] {
  return findNormalizedTextTransformerMatches(input, cursor, normalizeTextTransformers(transformers));
}

export function findNormalizedTextTransformerMatches(
  input: string,
  cursor: number,
  transformers: readonly TextTransformer[],
): TextTransformer[] {
  const matches: TextTransformer[] = [];
  for (const item of transformers) {
    if (!item.enabled || transformerContext(input, cursor, item) === null) continue;
    matches.push(item);
    if (matches.length === MAX_TEXT_TRANSFORMER_MATCHES) break;
  }
  return matches;
}

export function applyTextTransformerAtCursor(
  input: string,
  cursor: number,
  transformers: readonly TextTransformerInput[],
  trailingText = '',
  variables: TextTransformerVariables = {},
): TextTransformerApplication {
  const entries = normalizeTextTransformers(transformers).filter((item) => item.enabled);
  const boundedCursor = Math.max(0, Math.min(cursor, input.length));
  const transformer = entries.find((item) => {
    const sequence = textTransformerSequence(item);
    const start = boundedCursor - sequence.length;
    return (
      start >= 0 &&
      hasValidStartBoundary(input, start) &&
      hasSameText(input.slice(start, boundedCursor), sequence)
    );
  });
  if (!transformer) return { text: input, cursor, replaced: false };
  const context = {
    start: boundedCursor - textTransformerSequence(transformer).length,
    end: boundedCursor,
  };
  return applyTransformerAtContext(input, context, transformer, trailingText, variables);
}

export function applyTextTransformerSelectionAtCursor(
  input: string,
  selectionStart: number,
  selectionEnd: number,
  transformerInput: TextTransformerInput,
  trailingText = '',
  variables: TextTransformerVariables = {},
): TextTransformerApplication {
  const transformer = normalizeTextTransformers([transformerInput])[0];
  if (!transformer || !transformer.enabled) {
    return { text: input, cursor: selectionStart, replaced: false };
  }
  const context = transformerContext(input, selectionStart, transformer);
  if (!context) return { text: input, cursor: selectionStart, replaced: false };
  const sequence = textTransformerSequence(transformer);
  const typedLength = context.end - context.start;
  const sequenceSuffix = sequence.slice(typedLength);
  const inputSuffix = input.slice(context.end, context.end + sequenceSuffix.length);
  const consumedSuffixLength = hasSameText(inputSuffix, sequenceSuffix)
    ? sequenceSuffix.length
    : 0;
  const boundedSelectionEnd = Math.max(
    selectionStart,
    Math.min(selectionEnd, input.length),
    context.end + consumedSuffixLength,
  );
  return applyTransformerAtContext(
    input,
    { ...context, end: boundedSelectionEnd },
    transformer,
    trailingText,
    variables,
  );
}

export function expandTextTransformers(
  input: string,
  transformers: readonly TextTransformerInput[],
  variables: TextTransformerVariables = {},
): string {
  const entries = normalizeTextTransformers(transformers)
    .filter((item) => item.enabled)
    .sort(
      (left, right) =>
        textTransformerSequence(right).length - textTransformerSequence(left).length,
    );
  if (entries.length === 0) return input;
  const alternatives = entries
    .map((item) => escapeRegularExpression(textTransformerSequence(item)))
    .join('|');
  const pattern = new RegExp(`(${alternatives})(?![\\p{L}\\p{M}\\p{N}\\p{Pc}])`, 'giu');
  return input.replace(pattern, (match, sequence: string, offset: number) => {
    if (!hasValidStartBoundary(input, offset)) return match;
    const transformer = transformerBySequence(entries, sequence);
    if (!transformer) return match;
    return resolveTextTransformerBody(transformer.body, variables)?.text ?? match;
  });
}
