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
  switch (tool) {
    case 'bash':
      return '#a855f7';
    case 'read':
      return '#60a5fa';
    case 'grep':
      return '#facc15';
    case 'glob':
      return '#facc15';
    case 'list':
      return '#60a5fa';
    case 'edit':
    case 'multiedit':
    case 'apply_patch':
      return '#f97316';
    case 'write':
      return '#f97316';
    case 'webfetch':
    case 'websearch':
    case 'codesearch':
      return '#2dd4bf';
    case 'task':
      return '#818cf8';
    case 'batch':
      return '#818cf8';
    case 'plan_enter':
    case 'plan_exit':
      return '#94a3b8';
    default:
      return '#64748b';
  }
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
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'vue':
      return 'vue';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'diff':
    case 'patch':
      return 'diff';
    case 'sh':
      return 'shellscript';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'php':
      return 'php';
    case 'sql':
      return 'sql';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'rb':
      return 'ruby';
    case 'toml':
      return 'toml';
    case 'xml':
      return 'xml';
    case 'c':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
      return 'cpp';
    case 'h':
    case 'hpp':
      return 'cpp';
    default:
      return 'text';
  }
}
