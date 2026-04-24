import { resolveToolAccentColor } from '../../utils/theme';

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

export function formatReadLikeToolTitle(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const filePath = typeof input?.filePath === 'string' ? input.filePath.trim() : '';
  if (filePath) return filePath;
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  return path || undefined;
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
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'cjs':
    case 'mjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'vue':
      return 'vue';
    case 'svelte':
      return 'svelte';
    case 'astro':
      return 'astro';
    case 'json':
    case 'json5':
    case 'jsonc':
      return 'json';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'toml':
      return 'toml';
    case 'md':
    case 'mdc':
    case 'mdx':
      return 'markdown';
    case 'html':
    case 'htm':
      return 'html';
    case 'xml':
    case 'svg':
      return 'xml';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'sass':
      return 'sass';
    case 'less':
      return 'less';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shellscript';
    case 'py':
    case 'pyw':
      return 'python';
    case 'c':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'h':
    case 'hpp':
    case 'hh':
      return 'cpp';
    case 'java':
      return 'java';
    case 'cs':
      return 'csharp';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'rb':
    case 'erb':
      return 'ruby';
    case 'php':
      return 'php';
    case 'pl':
    case 'pm':
      return 'perl';
    case 'lua':
      return 'lua';
    case 'sql':
      return 'sql';
    case 'dockerfile':
      return 'dockerfile';
    case 'mk':
    case 'mak':
      return 'makefile';
    case 'diff':
    case 'patch':
      return 'diff';
    case 'gql':
    case 'graphql':
      return 'graphql';
    case 'regex':
    case 'regexp':
      return 'regex';
    case 'coffee':
    case 'coffeescript':
      return 'coffee';
    case 'r':
      return 'r';
    case 'jl':
      return 'julia';
    case 'wasm':
      return 'wasm';
    case 'wgsl':
      return 'wgsl';
    case 'fasta':
    case 'fa':
    case 'fna':
    case 'faa':
      return 'fasta';
    case 'fastq':
    case 'fq':
      return 'fastq';
    case 'sam':
      return 'sam';
    case 'vcf':
      return 'vcf';
    case 'bed':
      return 'bed';
    case 'gtf':
    case 'gff':
    case 'gff3':
      return 'gtf';
    default:
      if (path.toLowerCase().endsWith('makefile')) return 'makefile';
      if (path.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
      return 'text';
  }
}
