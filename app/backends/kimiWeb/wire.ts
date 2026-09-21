/**
 * Kimi Web wire protocol surface: envelope, payload guards, the supported /
 * ignored event registries and the tool-name + subagent-identity mappings.
 */
import { isPluginToolName } from '../../utils/pluginCompatibility';

export type KimiWebWireFrame = {
  type: string;
  seq?: number;
  epoch?: string;
  volatile?: boolean;
  offset?: number;
  session_id?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
  /** Test-only provenance marker on spec-derived fixture lines. */
  _provenance?: string;
};

export type KimiWebPayload = Record<string, unknown>;

export type KimiWebUsage = {
  inputOther?: number;
  output?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
};
export type KimiWebUsageReport = {
  byModel?: Record<string, KimiWebUsage>;
  total?: KimiWebUsage;
  currentTurn?: KimiWebUsage;
};
export type KimiWebAgentStatus = {
  model?: string;
  thinkingEffort?: string;
  contextTokens?: number;
  maxContextTokens?: number;
  contextUsage?: number;
  planMode?: boolean;
  swarmMode?: boolean;
  towerMode?: boolean;
  permission?: string;
  usage?: KimiWebUsageReport;
  phase?: KimiWebPayload;
};
export type KimiWebTurnReason = 'completed' | 'cancelled' | 'failed' | 'blocked';
export type KimiWebTurnError = { code?: string; message: string; retryable?: boolean; interruptReason?: string };

export const isRecord = (value: unknown): value is KimiWebPayload =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const asString = (value: unknown) => (typeof value === 'string' ? value : '');
export const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export const asBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function turnReason(value: unknown): KimiWebTurnReason {
  return value === 'cancelled' || value === 'failed' || value === 'blocked' ? value : 'completed';
}

export function splitModel(model: string) {
  const index = model.indexOf('/');
  if (index <= 0) return { providerID: 'kimi-code', modelID: model };
  return { providerID: model.slice(0, index), modelID: model.slice(index + 1) };
}

/** Event types with a mapping in this module (every one has a fixture in ./fixtures). */
export const KIMI_WEB_SUPPORTED_EVENTS: ReadonlySet<string> = new Set([
  'turn.started', 'turn.ended',
  'turn.step.started', 'turn.step.completed', 'turn.step.retrying', 'turn.step.interrupted',
  'assistant.delta', 'thinking.delta',
  'tool.call.started', 'tool.progress', 'tool.result',
  'agent.created', 'agent.disposed', 'agent.status.updated',
  'session.meta.updated',
  'event.session.created', 'event.session.archived', 'event.session.deleted',
  'event.session.work_changed', 'event.session.status_changed',
  'event.approval.requested', 'event.approval.resolved',
  'event.question.requested', 'event.question.answered', 'event.question.dismissed',
  'prompt.submitted', 'prompt.started', 'prompt.completed', 'prompt.aborted', 'prompt.steered',
  'subagent.spawned', 'subagent.started', 'subagent.suspended', 'subagent.completed', 'subagent.failed',
  'compaction.started', 'compaction.blocked', 'compaction.cancelled', 'compaction.completed',
  'error', 'warning', 'context.spliced',
]);

/** Protocol control frames and kimi-only surfaces out of scope for the message store. */
export const KIMI_WEB_IGNORED_EVENTS: ReadonlySet<string> = new Set([
  'server_hello', 'ping', 'pong', 'ack', 'resync_required',
  'tool.call.delta', 'tool.list.updated', 'hook.result', 'mcp.server.status',
  'shell.started', 'shell.output', 'shell.completed',
  'task.started', 'task.terminated', 'background.task.started', 'background.task.terminated',
  'cron.fired', 'goal.updated', 'skill.activated', 'plugin_command.activated',
  'event.workspace.created', 'event.workspace.updated', 'event.workspace.deleted',
  'event.config.changed', 'event.config.warning', 'event.model_catalog.changed',
  'event.di.unit_changed', 'event.plugin.changed', 'event.capability.changed',
]);

const KIMI_TOOL_SYNONYMS: Record<string, string> = {
  read: 'read', write: 'write', edit: 'edit', multiedit: 'multiedit',
  bash: 'bash', shell: 'bash', execute: 'bash',
  glob: 'glob', grep: 'grep', list: 'list', ls: 'list',
  codesearch: 'codesearch', applypatch: 'apply_patch',
  websearch: 'websearch', fetchurl: 'webfetch', webfetch: 'webfetch',
  agent: 'task', agentswarm: 'task', task: 'task',
  todolist: 'todowrite', todoread: 'todoread', todowrite: 'todowrite',
  askuserquestion: 'question',
  enterplanmode: 'plan_enter', exitplanmode: 'plan_exit', lsp: 'lsp',
};

/** Map a kimi tool name onto the TOOL_WINDOW_SUPPORTED synonym space; plugin prefixes stay verbatim. */
export function resolveKimiWebToolName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'other';
  if (isPluginToolName(trimmed)) return trimmed;
  const key = trimmed.toLocaleLowerCase().replace(/[^a-z0-9]/gu, '');
  return KIMI_TOOL_SYNONYMS[key] ?? trimmed;
}

/**
 * Stable subagent identity key: kimi hierarchy is session → agent → turn and
 * subagent events carry no independent sub-session id, so synthesize one.
 * The result is never equal to the parent session id (suffix is appended).
 */
export function kimiWebSubagentSessionId(sessionId: string, agentId: string, turnId = 0): string {
  return `${sessionId}:${agentId}:${turnId}`;
}
