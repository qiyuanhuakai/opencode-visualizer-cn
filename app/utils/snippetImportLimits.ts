export const MAX_TEXT_TRANSFORMER_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_TRANSFORMER_IMPORT_COUNT = 1_000;

const MAX_TAGS = 256;
const MAX_TAG_LENGTH = 256;
const MAX_TRIGGER_LENGTH = 256;
const MAX_BODY_LENGTH = 1024 * 1024;
const OPTIONAL_STRING_LIMITS = [
  ['id', 512],
  ['name', 512],
  ['description', 4_096],
] as const;

function boundedOptionalStrings(value: object): boolean {
  return OPTIONAL_STRING_LIMITS.every(([field, maximumLength]) => {
    const entry = Reflect.get(value, field);
    return entry === undefined || (typeof entry === 'string' && entry.length <= maximumLength);
  });
}

function boundedTags(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_TAGS) return false;
  return value.every((tag) => typeof tag === 'string' && tag.length <= MAX_TAG_LENGTH);
}

function importBody(value: object): unknown {
  return Reflect.get(value, 'body') ?? Reflect.get(value, 'replacement');
}

export function isBoundedTextTransformerImportSnippet(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const trigger = Reflect.get(value, 'trigger');
  const body = importBody(value);
  const enabled = Reflect.get(value, 'enabled');
  if (typeof trigger !== 'string' || trigger.length > MAX_TRIGGER_LENGTH) return false;
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH) return false;
  if (enabled !== undefined && typeof enabled !== 'boolean') return false;
  return boundedOptionalStrings(value) && boundedTags(Reflect.get(value, 'tags'));
}
