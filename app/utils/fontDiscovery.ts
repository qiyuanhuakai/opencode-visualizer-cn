export type LocalFontFamily = {
  family: string;
  fullNames: string[];
  postscriptNames: string[];
  styles: string[];
};

export type FontAvailabilityStatus = 'available' | 'missing' | 'generic';

const fontAvailabilityCache = new Map<string, FontAvailabilityStatus>();

type LocalFontRecord = {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
};

type LocalFontAccessWindow = Window & {
  queryLocalFonts?: () => Promise<LocalFontRecord[]>;
};

const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

const FONT_TEST_TEXT = 'mmmmmmmmmmlli00WQ@#';
const FONT_TEST_SIZE = '72px';
const FONT_TEST_BASELINES = ['monospace', 'sans-serif', 'serif'] as const;

export function supportsLocalFontAccess() {
  return typeof window !== 'undefined' && 'queryLocalFonts' in window;
}

export async function loadLocalFontFamilies(): Promise<LocalFontFamily[]> {
  if (!supportsLocalFontAccess()) return [];
  const localWindow = window as LocalFontAccessWindow;
  const fonts = await localWindow.queryLocalFonts?.();
  if (!fonts?.length) return [];

  const grouped = new Map<string, LocalFontFamily>();
  for (const font of fonts) {
    const family = font.family.trim();
    if (!family) continue;
    const entry = grouped.get(family) ?? {
      family,
      fullNames: [],
      postscriptNames: [],
      styles: [],
    };
    pushUnique(entry.fullNames, font.fullName.trim());
    pushUnique(entry.postscriptNames, font.postscriptName.trim());
    pushUnique(entry.styles, font.style.trim());
    grouped.set(family, entry);
  }

  return Array.from(grouped.values()).sort((a, b) =>
    a.family.localeCompare(b.family, undefined, { sensitivity: 'base' }),
  );
}

export function parseFontStack(stack: string) {
  const families: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of stack) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ',') {
      const normalized = normalizeFontFamilyToken(current);
      if (normalized) families.push(normalized);
      current = '';
      continue;
    }

    current += char;
  }

  const normalized = normalizeFontFamilyToken(current);
  if (normalized) families.push(normalized);
  return families;
}

export function prependFontFamilyToStack(stack: string, family: string) {
  const normalizedFamily = normalizeFontFamilyToken(family);
  if (!normalizedFamily) return stack;
  const dedupedTail = parseFontStack(stack).filter(
    (item) => item.toLocaleLowerCase() !== normalizedFamily.toLocaleLowerCase(),
  );
  return [normalizedFamily, ...dedupedTail]
    .map((item) => formatFontFamilyForStack(item))
    .join(', ');
}

export function formatFontFamilyForStack(family: string) {
  const normalized = normalizeFontFamilyToken(family);
  if (!normalized) return '';
  if (isGenericFontFamily(normalized)) return normalized;
  const escaped = normalized.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  return `'${escaped}'`;
}

export function inspectFontStack(stack: string) {
  return parseFontStack(stack).map((family) => ({
    family,
    status: detectFontFamilyAvailability(family),
  }));
}

export function isGenericFontFamily(family: string) {
  return GENERIC_FONT_FAMILIES.has(normalizeFontFamilyToken(family).toLocaleLowerCase());
}

export function detectFontFamilyAvailability(family: string): FontAvailabilityStatus {
  const normalized = normalizeFontFamilyToken(family);
  if (!normalized) return 'missing';
  if (isGenericFontFamily(normalized)) return 'generic';
  const cacheKey = normalized.toLocaleLowerCase();
  const cached = fontAvailabilityCache.get(cacheKey);
  if (cached) return cached;
  if (typeof document === 'undefined') return 'missing';

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return 'missing';

  const targetFamily = formatFontFamilyForStack(normalized);
  const available = FONT_TEST_BASELINES.some((fallback) => {
    context.font = `${FONT_TEST_SIZE} ${fallback}`;
    const baselineWidth = context.measureText(FONT_TEST_TEXT).width;
    context.font = `${FONT_TEST_SIZE} ${targetFamily}, ${fallback}`;
    const measuredWidth = context.measureText(FONT_TEST_TEXT).width;
    return measuredWidth !== baselineWidth;
  });

  const result = available ? 'available' : 'missing';
  fontAvailabilityCache.set(cacheKey, result);
  return result;
}

function normalizeFontFamilyToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function pushUnique(list: string[], value: string) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}
