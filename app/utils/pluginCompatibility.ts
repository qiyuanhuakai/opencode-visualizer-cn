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
  return typeof category === 'string' && category.trim()
    ? `Sisyphus-Junior(${category.trim()})`
    : fallback;
}

export function collectMagicContextWorkers(
  metaById: Record<
    string,
    { readonly label: string; readonly status?: SessionState['status'] }
  >,
): MagicContextWorker[] {
  const priority: Record<MagicContextWorker['status'], number> = {
    busy: 0,
    retry: 1,
    idle: 2,
  };
  return Object.entries(metaById)
    .filter(([, meta]) => isMagicContextWorkerName(meta.label))
    .map(([sessionId, meta]) => ({
      sessionId,
      name: meta.label,
      status: meta.status ?? 'idle',
    }))
    .sort(
      (left, right) =>
        priority[left.status] - priority[right.status] || left.name.localeCompare(right.name),
    );
}
