import type { useCodexApi } from '../../composables/useCodexApi';

type CodexEvent = ReturnType<typeof useCodexApi>['events']['value'][number];
export type ObservedTerminalStatus = 'inProgress' | 'completed' | 'failed' | 'declined' | 'unknown';
type TerminalState = {
  id: string;
  command: string;
  cwd: string;
  processId: string;
  status: ObservedTerminalStatus;
  exitCode?: number;
  output: string;
  updatedTime: number;
  interactionTime?: number;
};

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}
function status(value: unknown): ObservedTerminalStatus {
  switch (value) {
    case 'inProgress':
    case 'completed':
    case 'failed':
    case 'declined':
      return value;
    default:
      return 'unknown';
  }
}
function command(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').join(' ')
    : text(value);
}

export function observeCodexTerminals(events: readonly CodexEvent[], threadId: string) {
  const terminals = new Map<string, TerminalState>();
  if (!threadId) return [];
  for (const event of events) {
    const params = record(event.params);
    if (params.threadId !== threadId) continue;
    const item = record(params.item);
    const isItem =
      (event.method === 'item/started' || event.method === 'item/completed') &&
      item.type === 'commandExecution';
    const isOutput = event.method === 'item/commandExecution/outputDelta';
    const isInteraction = event.method === 'item/commandExecution/terminalInteraction';
    if (!isItem && !isOutput && !isInteraction) continue;
    const id = text(isItem ? item.id : params.itemId);
    if (!id) continue;
    const terminal = terminals.get(id) ?? {
      id,
      command: '',
      cwd: '',
      processId: '',
      status: 'unknown',
      output: '',
      updatedTime: event.time,
    };
    if (isItem) {
      terminal.command = command(item.command) || terminal.command;
      terminal.cwd = text(item.cwd) || terminal.cwd;
      terminal.processId = text(item.processId) || terminal.processId;
      terminal.status = status(
        item.status ?? (event.method === 'item/completed' ? 'completed' : 'inProgress'),
      );
      if (typeof item.exitCode === 'number') terminal.exitCode = item.exitCode;
      const finalOutput =
        typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : item.output;
      if (typeof finalOutput === 'string') terminal.output = finalOutput;
    }
    if (isOutput) terminal.output += text(params.delta);
    if (isInteraction) {
      terminal.processId = text(params.processId) || terminal.processId;
      terminal.interactionTime = event.time;
    }
    terminal.updatedTime = event.time;
    terminals.set(id, terminal);
  }
  return Array.from(terminals.values())
    .sort((left, right) => right.updatedTime - left.updatedTime)
    .map(({ output, ...terminal }) => ({
      ...terminal,
      outputLines: output
        .split(/\r\n|\r|\n/)
        .filter((line) => line.trim().length > 0)
        .slice(-3),
    }));
}
