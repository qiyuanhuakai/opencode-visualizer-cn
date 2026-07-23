import { createAcpSessionState, type AcpSessionState } from './history';
import { parseSessionConfigOptions } from './wire';

export async function loadAcpSessionHistory(options: {
  sessionId: string;
  directory?: string;
  sessions: Map<string, AcpSessionState>;
  loadedSessions: Set<string>;
  supports(method: string): boolean;
  request(method: string, params: unknown): Promise<unknown>;
  isCurrent?(): boolean;
}) {
  const isCurrent = options.isCurrent ?? (() => true);
  let state = options.sessions.get(options.sessionId);
  if (!state) {
    state = createAcpSessionState({
      id: options.sessionId,
      directory: options.directory,
      title: options.sessionId,
    });
    options.sessions.set(options.sessionId, state);
  }
  if (options.loadedSessions.has(options.sessionId)) return state.entries;
  const params = {
    sessionId: options.sessionId,
    cwd: options.directory ?? state.info.directory ?? '',
    mcpServers: [],
  };
  const method = options.supports('session/load')
    ? 'session/load'
    : options.supports('session/resume')
      ? 'session/resume'
      : undefined;
  let result: unknown;
  if (method) {
    const previous = state;
    state = createAcpSessionState(previous.info, previous.configOptions);
    state.availableCommands = previous.availableCommands;
    options.sessions.set(options.sessionId, state);
    try {
      result = await options.request(method, params);
    } catch (error) {
      if (isCurrent()) options.sessions.set(options.sessionId, previous);
      throw error;
    }
  }
  if (!isCurrent()) throw new Error('ACP session history load was superseded.');
  const configOptions = parseSessionConfigOptions(result);
  if (configOptions.length > 0) state.configOptions = configOptions;
  options.loadedSessions.add(options.sessionId);
  return state.entries;
}
