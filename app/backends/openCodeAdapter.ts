import * as opencodeApi from '../utils/opencode';
import type { BackendAdapter } from './types';

export function createOpenCodeAdapter(): BackendAdapter {
  return {
    kind: 'opencode',
    label: 'OpenCode',
    capabilities: {
      projects: true,
      worktrees: true,
      sessions: true,
      sessionFork: true,
      sessionRevert: true,
    },
    createSession: (directory) => opencodeApi.createSession(directory),
    forkSession: (sessionId, messageId, directory) =>
      opencodeApi.forkSession(sessionId, messageId, directory),
    updateSession: (sessionId, payload, directory) =>
      opencodeApi.updateSession(sessionId, payload, directory),
    deleteSession: (sessionId, directory) => opencodeApi.deleteSession(sessionId, directory),
    revertSession: (sessionId, messageId, directory) =>
      opencodeApi.revertSession(sessionId, messageId, directory),
    unrevertSession: (sessionId, directory) => opencodeApi.unrevertSession(sessionId, directory),
    listSessions: (options) => opencodeApi.listSessions(options),
    updateProject: (projectId, payload) => opencodeApi.updateProject(projectId, payload),
    createWorktree: (directory) => opencodeApi.createWorktree(directory),
    deleteWorktree: (directory, targetDirectory) =>
      opencodeApi.deleteWorktree(directory, targetDirectory),
  };
}
