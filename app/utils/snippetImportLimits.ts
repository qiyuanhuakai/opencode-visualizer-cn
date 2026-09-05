export const MAX_TEXT_TRANSFORMER_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_TRANSFORMER_IMPORT_COUNT = 1_000;
export const MAX_TEXT_TRANSFORMER_TOTAL_TAGS = 1_000;

export const MAX_TEXT_TRANSFORMER_TAGS = 256;
export const MAX_TEXT_TRANSFORMER_TAG_LENGTH = 256;
export const MAX_TEXT_TRANSFORMER_TAG_DRAFT_LENGTH =
  MAX_TEXT_TRANSFORMER_TAGS * MAX_TEXT_TRANSFORMER_TAG_LENGTH + (MAX_TEXT_TRANSFORMER_TAGS - 1) * 2;
export const MAX_TEXT_TRANSFORMER_TRIGGER_LENGTH = 256;
export const MAX_TEXT_TRANSFORMER_NAME_LENGTH = 512;
export const MAX_TEXT_TRANSFORMER_DESCRIPTION_LENGTH = 4_096;
export const MAX_TEXT_TRANSFORMER_BODY_LENGTH = 1024 * 1024;
const OPTIONAL_STRING_LIMITS = [
  ['id', 512],
  ['name', MAX_TEXT_TRANSFORMER_NAME_LENGTH],
  ['description', MAX_TEXT_TRANSFORMER_DESCRIPTION_LENGTH],
] as const;

export function truncateTextTransformerString(value: string, maximumLength: number): string {
  let end = Math.min(value.length, maximumLength);
  const lastCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (
    end < value.length &&
    lastCodeUnit >= 0xd800 &&
    lastCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function isBoundedWellFormedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximumLength &&
    String.prototype.isWellFormed.call(value)
  );
}

function boundedOptionalStrings(value: object): boolean {
  return OPTIONAL_STRING_LIMITS.every(([field, maximumLength]) => {
    const entry = Reflect.get(value, field);
    return entry === undefined || isBoundedWellFormedString(entry, maximumLength);
  });
}

function boundedTags(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_TEXT_TRANSFORMER_TAGS) return false;
  return value.every((tag) => isBoundedWellFormedString(tag, MAX_TEXT_TRANSFORMER_TAG_LENGTH));
}

function importBody(value: object): unknown {
  return Reflect.get(value, 'body') ?? Reflect.get(value, 'replacement');
}

export function isBoundedTextTransformerImportSnippet(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const trigger = Reflect.get(value, 'trigger');
  const body = importBody(value);
  const enabled = Reflect.get(value, 'enabled');
  if (!isBoundedWellFormedString(trigger, MAX_TEXT_TRANSFORMER_TRIGGER_LENGTH)) {
    return false;
  }
  if (!isBoundedWellFormedString(body, MAX_TEXT_TRANSFORMER_BODY_LENGTH)) return false;
  if (enabled !== undefined && typeof enabled !== 'boolean') return false;
  return boundedOptionalStrings(value) && boundedTags(Reflect.get(value, 'tags'));
}
