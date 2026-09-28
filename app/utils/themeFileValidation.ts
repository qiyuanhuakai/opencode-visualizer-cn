import themeSchema from '../schema/theme.schema.json';

const definitions: Record<string, unknown> = themeSchema.$defs;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(path: string, detail: string): never {
  throw new Error(`Invalid theme field ${path || 'theme'}: ${detail}.`);
}

function validateSchemaNode(value: unknown, schema: unknown, path = ''): void {
  if (!isRecord(schema)) invalid(path, 'invalid schema');
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    validateSchemaNode(value, definitions[name], path);
    return;
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) invalid(path, 'expected an object');
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) invalid(path ? `${path}.${key}` : key, 'is required');
    }
    for (const [key, field] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in properties)) {
        if (schema.additionalProperties === false) invalid(childPath, 'unknown field');
        continue;
      }
      validateSchemaNode(field, properties[key], childPath);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) invalid(path, 'expected an array');
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) invalid(path, 'too many items');
    value.forEach((item, index) => validateSchemaNode(item, schema.items, `${path}.${index}`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') invalid(path, 'expected a string');
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) invalid(path, 'is empty');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) invalid(path, 'invalid format');
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) invalid(path, 'expected an integer');
  }
  if ('const' in schema && value !== schema.const) invalid(path, 'unsupported version');
}

function validateCssValue(value: string, path: string, field: string): void {
  const property = field.endsWith('Opacity') || field === 'opacity'
    ? 'opacity'
    : field === 'backgroundImage'
      ? 'background-image'
      : field.toLowerCase().includes('shadow') || field === 'focusRing'
        ? 'box-shadow'
        : field.toLowerCase().includes('bg') || field === 'backgroundColor'
          ? 'background'
          : 'color';
  if (property === 'opacity' && !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
    invalid(path, 'opacity must be between 0 and 1');
  }
  if (value.startsWith('#') && !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    invalid(path, 'invalid CSS color');
  }
  const supports = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports(property, value)
    : /^(?:#[0-9a-f]{3,8}|transparent|currentColor|none|(?:rgb|rgba|hsl|hsla|color-mix|linear-gradient|radial-gradient|repeating-linear-gradient)\(.+\)|\d+(?:\.\d+)?)$/i.test(value);
  if (!supports) invalid(path, `unsupported CSS ${property} value`);
}

function validateCssGroup(group: unknown, path: string): void {
  if (!isRecord(group)) return;
  for (const [field, value] of Object.entries(group)) {
    const fieldPath = `${path}.${field}`;
    if (typeof value === 'string') validateCssValue(value, fieldPath, field);
    else validateCssGroup(value, fieldPath);
  }
}

export function validateExternalThemeFile(input: unknown): void {
  validateSchemaNode(input, themeSchema);
  if (!isRecord(input)) return;
  validateCssGroup(input.regions, 'regions');
  validateCssGroup(input.components, 'components');
  validateCssGroup(input.floating, 'floating');
  if (Array.isArray(input.swatches)) {
    input.swatches.forEach((swatch, index) => {
      if (typeof swatch === 'string') validateCssValue(swatch, `swatches.${index}`, 'color');
    });
  }
}
