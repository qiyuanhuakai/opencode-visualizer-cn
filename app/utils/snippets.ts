import {
  isBoundedTextTransformerImportSnippet,
  MAX_TEXT_TRANSFORMER_IMPORT_BYTES,
  MAX_TEXT_TRANSFORMER_IMPORT_COUNT,
} from './snippetImportLimits';

export type TextTransformer = {
  readonly id: string;
  readonly trigger: string;
  readonly name: string;
  readonly body: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly tags: readonly string[];
};

export type LegacyTextTransformer = {
  readonly trigger: string;
  readonly replacement: string;
};

export type TextTransformerInput = TextTransformer | LegacyTextTransformer;

export type TextTransformerImportFailure =
  | 'invalid-json'
  | 'unsupported-version'
  | 'invalid-snippets';

export type TextTransformerImportResult =
  | { readonly ok: true; readonly snippets: TextTransformer[] }
  | { readonly ok: false; readonly reason: TextTransformerImportFailure };

export const TEXT_TRANSFORMER_EXPORT_VERSION = 1;
export {
  MAX_TEXT_TRANSFORMER_IMPORT_BYTES,
  MAX_TEXT_TRANSFORMER_IMPORT_COUNT,
} from './snippetImportLimits';
const simpleCaseFoldCache = new Map<string, string>();

function normalizeTrigger(value: string): string {
  return value.trim().replace(/^\\+/u, '');
}

export function isValidTextTransformerTrigger(value: string): boolean {
  return value.length > 0 && !/[\s\\]/u.test(value) && !/^[/@$]/u.test(value);
}

function isLegacyReservedTrigger(value: string): boolean {
  return value.length > 0 && !/[\s\\]/u.test(value) && /^[/@$]/u.test(value);
}

function stableSnippetId(trigger: string, body: string): string {
  let hash = 0x811c9dc5;
  for (const character of `${trigger}\0${body}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `snippet-${(hash >>> 0).toString(36)}`;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || keys.has(key)) continue;
    keys.add(key);
    tags.push(tag);
  }
  return tags;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function snippetBody(value: object): string | null {
  const body = Reflect.get(value, 'body');
  if (typeof body === 'string') return body;
  const legacyReplacement = Reflect.get(value, 'replacement');
  return typeof legacyReplacement === 'string' ? legacyReplacement : null;
}

function normalizeSnippetTrigger(
  value: unknown,
  enabled: unknown,
): { trigger: string; enabled: boolean } | null {
  if (typeof value !== 'string') return null;
  const trigger = normalizeTrigger(value);
  if (isValidTextTransformerTrigger(trigger)) {
    return { trigger, enabled: typeof enabled === 'boolean' ? enabled : true };
  }
  return isLegacyReservedTrigger(trigger) ? { trigger, enabled: false } : null;
}

function normalizeSnippet(value: object): TextTransformer | null {
  const normalizedTrigger = normalizeSnippetTrigger(
    Reflect.get(value, 'trigger'),
    Reflect.get(value, 'enabled'),
  );
  if (!normalizedTrigger) return null;
  const body = snippetBody(value);
  if (body === null) return null;

  const { trigger, enabled } = normalizedTrigger;
  const id = optionalTrimmedString(Reflect.get(value, 'id')) ?? stableSnippetId(trigger, body);
  const name = optionalTrimmedString(Reflect.get(value, 'name')) ?? trigger;
  const description = optionalTrimmedString(Reflect.get(value, 'description'));
  const snippet = {
    id,
    trigger,
    name,
    body,
    enabled,
    tags: normalizeTags(Reflect.get(value, 'tags')),
  };
  return description ? { ...snippet, description } : snippet;
}

function hasSameTrigger(left: string, right: string): boolean {
  const escaped = left.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped}$`, 'iu').test(right);
}

function isSingleCodePoint(value: string): boolean {
  const iterator = value[Symbol.iterator]();
  return !iterator.next().done && iterator.next().done === true;
}

function simpleCaseFoldCharacter(character: string): string {
  const cached = simpleCaseFoldCache.get(character);
  if (cached) return cached;
  const lowercase = character.toLowerCase();
  const lowerUpper = isSingleCodePoint(lowercase) ? lowercase.toUpperCase() : '';
  const candidates = isSingleCodePoint(lowerUpper)
    ? [lowerUpper, character.toUpperCase(), lowercase]
    : [lowercase, character.toUpperCase()];
  const key =
    candidates.find(
      (candidate) =>
        isSingleCodePoint(candidate) &&
        (candidate === character || hasSameTrigger(character, candidate)),
    ) ?? character;
  simpleCaseFoldCache.set(character, key);
  return key;
}

function hasImportableTrigger(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const rawTrigger = Reflect.get(value, 'trigger');
  if (typeof rawTrigger !== 'string') return false;
  const trigger = normalizeTrigger(rawTrigger);
  if (isValidTextTransformerTrigger(trigger)) return true;
  return isLegacyReservedTrigger(trigger) && Reflect.get(value, 'enabled') === false;
}

export function textTransformerTriggerKey(value: string): string {
  return Array.from(normalizeTrigger(value), simpleCaseFoldCharacter).join('');
}

export function normalizeTextTransformers(value: unknown): TextTransformer[] {
  if (!Array.isArray(value)) return [];
  const normalized = new Map<string, TextTransformer>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const snippet = normalizeSnippet(item);
    if (!snippet) continue;
    const triggerKey = textTransformerTriggerKey(snippet.trigger);
    normalized.delete(triggerKey);
    normalized.set(triggerKey, snippet);
  }
  return [...normalized.values()];
}

export function serializeTextTransformers(transformers: readonly TextTransformerInput[]): string {
  return JSON.stringify(
    {
      version: TEXT_TRANSFORMER_EXPORT_VERSION,
      snippets: normalizeTextTransformers(transformers),
    },
    null,
    2,
  );
}

export function parseTextTransformerImport(input: string): TextTransformerImportResult {
  if (input.length > MAX_TEXT_TRANSFORMER_IMPORT_BYTES) {
    return { ok: false, reason: 'invalid-snippets' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (Reflect.get(parsed, 'version') !== TEXT_TRANSFORMER_EXPORT_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  const rawSnippets = Reflect.get(parsed, 'snippets');
  if (!Array.isArray(rawSnippets)) return { ok: false, reason: 'invalid-snippets' };
  if (
    rawSnippets.length > MAX_TEXT_TRANSFORMER_IMPORT_COUNT ||
    !rawSnippets.every(
      (snippet) =>
        isBoundedTextTransformerImportSnippet(snippet) && hasImportableTrigger(snippet),
    )
  ) {
    return { ok: false, reason: 'invalid-snippets' };
  }
  const snippets = normalizeTextTransformers(rawSnippets);
  if (snippets.length !== rawSnippets.length) {
    return { ok: false, reason: 'invalid-snippets' };
  }
  const ids = new Set(snippets.map((snippet) => snippet.id));
  if (ids.size !== snippets.length) return { ok: false, reason: 'invalid-snippets' };
  return { ok: true, snippets };
}

export function mergeTextTransformers(
  current: readonly TextTransformerInput[],
  imported: readonly TextTransformerInput[],
): TextTransformer[] {
  const mergedById = new Map<string, TextTransformer>();
  const idByTrigger = new Map<string, string>();
  for (const snippet of [
    ...normalizeTextTransformers(current),
    ...normalizeTextTransformers(imported),
  ]) {
    const triggerKey = textTransformerTriggerKey(snippet.trigger);
    const replacedById = mergedById.get(snippet.id);
    if (replacedById) idByTrigger.delete(textTransformerTriggerKey(replacedById.trigger));
    const replacedId = idByTrigger.get(triggerKey);
    if (replacedId) mergedById.delete(replacedId);
    mergedById.delete(snippet.id);
    mergedById.set(snippet.id, snippet);
    idByTrigger.set(triggerKey, snippet.id);
  }
  return [...mergedById.values()];
}
