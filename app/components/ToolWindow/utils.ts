import { resolveToolAccentColor } from '../../utils/theme';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'jsx',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdc: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  py: 'python',
  pyw: 'python',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  java: 'java',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  erb: 'ruby',
  php: 'php',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  sql: 'sql',
  dockerfile: 'dockerfile',
  mk: 'makefile',
  mak: 'makefile',
  diff: 'diff',
  patch: 'diff',
  gql: 'graphql',
  graphql: 'graphql',
  regex: 'regex',
  regexp: 'regex',
  coffee: 'coffee',
  coffeescript: 'coffee',
  r: 'r',
  jl: 'julia',
  wasm: 'wasm',
  wgsl: 'wgsl',
  fasta: 'fasta',
  fa: 'fasta',
  fna: 'fasta',
  faa: 'fasta',
  fastq: 'fastq',
  fq: 'fastq',
  sam: 'sam',
  vcf: 'vcf',
  bed: 'bed',
  gtf: 'gtf',
  gff: 'gtf',
  gff3: 'gtf',
};

export function formatGlobToolTitle(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const pattern = typeof input?.pattern === 'string' ? input.pattern.trim() : '';
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  const include = typeof input?.include === 'string' ? input.include.trim() : '';
  const segments: string[] = [];
  if (pattern) segments.push(pattern);
  if (path) segments.push(`@ ${path}`);
  if (include) segments.push(`include ${include}`);
  const title = segments.join(' ');
  return title || undefined;
}

export function resolveReadWritePath(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  state: Record<string, unknown> | undefined,
): string | undefined {
  const filePath = typeof input?.filePath === 'string' ? input.filePath.trim() : '';
  if (filePath) return filePath;
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  if (path) return path;
  const metadataPath = typeof metadata?.filepath === 'string' ? metadata.filepath.trim() : '';
  if (metadataPath) return metadataPath;
  const title = typeof state?.title === 'string' ? state.title.trim() : '';
  return title || undefined;
}

export function resolveReadRange(input: Record<string, unknown> | undefined): {
  offset?: number;
  limit?: number;
} {
  const offsetValue = input?.offset;
  const limitValue = input?.limit;
  const offset =
    typeof offsetValue === 'number' && Number.isFinite(offsetValue) && offsetValue >= 0
      ? Math.floor(offsetValue)
      : undefined;
  const limit =
    typeof limitValue === 'number' && Number.isFinite(limitValue) && limitValue > 0
      ? Math.floor(limitValue)
      : undefined;
  return { offset, limit };
}

export function formatListToolTitle(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  return path || undefined;
}

export function formatWebfetchToolTitle(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const url = typeof input?.url === 'string' ? input.url.trim() : '';
  return url || undefined;
}

export function formatQueryToolTitle(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  return query || undefined;
}

export function toolColor(tool: string): string {
  return resolveToolAccentColor(tool);
}

export function guessLanguageFromPath(path?: string): string {
  if (!path) return 'text';
  const normalizedPath = path.toLowerCase();
  const extension = normalizedPath.split('.').pop();
  if (extension) {
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language) return language;
  }
  if (normalizedPath.endsWith('makefile')) return 'makefile';
  if (normalizedPath.endsWith('dockerfile')) return 'dockerfile';
  return 'text';
}
