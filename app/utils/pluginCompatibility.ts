import type { ToolPart } from '../types/sse';
import type { SessionState } from '../types/worker-state';

const PLUGIN_TOOL_PREFIXES = [
  'lsp_',
  'lsp-',
  'codegraph_',
  'codegraph-',
  'ctx_',
  'ctx-',
] as const;

const MAGIC_CONTEXT_PREFIX = 'magic-context-';

export type MagicContextWorker = {
  readonly sessionId: string;
  readonly name: string;
  readonly status: NonNullable<SessionState['status']>;
};

export function isPluginToolName(tool: string): boolean {
  const normalized = tool.trim().toLocaleLowerCase();
  return PLUGIN_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isMagicContextWorkerName(name: string): boolean {
  return name.trim().toLocaleLowerCase().startsWith(MAGIC_CONTEXT_PREFIX);
}

export function resolveTaskWorkerLabel(part: ToolPart, fallback: string): string {
  const category = part.state.input?.category;
  if (typeof category !== 'string' || !category.trim()) return fallback;
  const workerLabel = `Sisyphus-Junior(${category.trim()})`;
  const subagentMarker = /(@)Sisyphus-Junior(?:\([^)]*\))?(?=\s+subagent\)\s*$)/i;
  if (subagentMarker.test(fallback)) {
    return fallback.replace(subagentMarker, `$1${workerLabel}`);
  }
  if (/^Sisyphus-Junior(?:\([^)]*\))?$/i.test(fallback.trim())) return workerLabel;
  const childSessionId = 'metadata' in part.state ? part.state.metadata?.sessionId : undefined;
  if (typeof childSessionId === 'string' && fallback.trim() === childSessionId.trim()) {
    return workerLabel;
  }
  return fallback.trim() ? `${fallback.trim()} (${workerLabel})` : workerLabel;
}

export function collectMagicContextWorkers(
  metaById: Record<
    string,
    {
      readonly parentID?: string;
      readonly label: string;
      readonly status?: SessionState['status'];
    }
  >,
  rootSessionId: string,
): MagicContextWorker[] {
  const rootId = rootSessionId.trim();
  if (!rootId) return [];
  const priority: Record<MagicContextWorker['status'], number> = {
    busy: 0,
    retry: 1,
    idle: 2,
  };
  return Object.entries(metaById)
    .flatMap(([sessionId, meta]) => {
      if (!isMagicContextWorkerName(meta.label) || !meta.status) return [];
      const visited = new Set([sessionId]);
      let ancestorId = meta.parentID;
      while (ancestorId && ancestorId !== rootId && !visited.has(ancestorId)) {
        visited.add(ancestorId);
        ancestorId = metaById[ancestorId]?.parentID;
      }
      if (sessionId !== rootId && ancestorId !== rootId) return [];
      return [{ sessionId, name: meta.label, status: meta.status }];
    })
    .sort(
      (left, right) =>
        priority[left.status] - priority[right.status] || left.name.localeCompare(right.name),
    );
}
