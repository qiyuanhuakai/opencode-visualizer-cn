import * as opencodeApi from '../utils/opencode';
import type { BackendAdapter } from './types';

type OpenCodeWorkerAdapter = Pick<
  BackendAdapter,
  | 'configure'
  | 'listProjects'
  | 'listSessions'
  | 'getCurrentProject'
  | 'getSession'
  | 'getVcsInfo'
  | 'getSessionStatusMap'
>;

function createOpenCodeConfigure(): NonNullable<BackendAdapter['configure']> {
  let configuredBaseUrl: string | undefined;
  return (options) => {
    const baseUrlChanged =
      options.baseUrl !== undefined && options.baseUrl !== configuredBaseUrl;
    if (options.baseUrl !== undefined) {
      configuredBaseUrl = options.baseUrl;
      opencodeApi.setBaseUrl(options.baseUrl);
    }
    if ('authorization' in options || baseUrlChanged) {
      opencodeApi.setAuthorization(options.authorization);
    }
  };
}

export function createOpenCodeWorkerAdapter(): OpenCodeWorkerAdapter {
  return {
    configure: createOpenCodeConfigure(),
    listProjects: (directory, options) => opencodeApi.listProjects(directory, options),
    listSessions: (options) => opencodeApi.listSessions(options),
    getCurrentProject: (directory, options) => opencodeApi.getCurrentProject(directory, options),
    getSession: (sessionId, directory, options) =>
      opencodeApi.getSession(sessionId, directory, options),
    getVcsInfo: (directory, options) => opencodeApi.getVcsInfo(directory, options),
    getSessionStatusMap: (directory, options) => opencodeApi.getSessionStatusMap(directory, options),
  };
}

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
      sessionRename: true,
      sessionArchive: true,
      sessionUnarchive: true,
      sessionDelete: true,
      sessionPin: true,
      sessionUnpin: true,
      sessionCompact: false,
      files: true,
      terminal: true,
      permissions: true,
      questions: true,
      todos: true,
      status: true,
      providerConfig: true,
      imageAttachmentsOnly: false,
      projectPickerCreatesSession: false,
      ptyExitRequiresSyntheticEvent: false,
      ptyRefreshArtifactsOnSuccess: false,
      strictSandboxPaths: false,
      sessionManagementMode: 'standard',
    },
    configure: createOpenCodeConfigure(),
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
    getPathInfo: (options) => opencodeApi.getPathInfo(options),
    getGlobalConfig: () => opencodeApi.getGlobalConfig(),
    updateGlobalConfig: (payload) => opencodeApi.updateGlobalConfig(payload),
    listFiles: (payload, options) => opencodeApi.listFiles(payload, options),
    readFileContent: (payload, options) => opencodeApi.readFileContent(payload, options),
    readFileContentBytes: (payload, options) => opencodeApi.readFileContentBytes(payload, options),
    getSessionDiff: (payload) => opencodeApi.getSessionDiff(payload),
    listProjects: (directory, options) => opencodeApi.listProjects(directory, options),
    getCurrentProject: (directory, options) => opencodeApi.getCurrentProject(directory, options),
    getSession: (sessionId, directory, options) => opencodeApi.getSession(sessionId, directory, options),
    getSessionChildren: (sessionId, directory, options) => opencodeApi.getSessionChildren(sessionId, directory, options),
    listWorktrees: (directory) => opencodeApi.listWorktrees(directory),
    getVcsInfo: (directory, options) => opencodeApi.getVcsInfo(directory, options),
    listProviders: () => opencodeApi.listProviders(),
    listProviderAuthMethods: (options) => opencodeApi.listProviderAuthMethods(options),
    authorizeProviderOAuth: (providerId, payload) => opencodeApi.authorizeProviderOAuth(providerId, payload),
    completeProviderOAuth: (providerId, payload) => opencodeApi.completeProviderOAuth(providerId, payload),
    setProviderAuth: (providerId, payload) => opencodeApi.setProviderAuth(providerId, payload),
    deleteProviderAuth: (providerId) => opencodeApi.deleteProviderAuth(providerId),
    listAgents: () => opencodeApi.listAgents(),
    listCommands: (directory) => opencodeApi.listCommands(directory),
    getSessionStatusMap: (directory, options) => opencodeApi.getSessionStatusMap(directory, options),
    listPendingPermissions: (directory) => opencodeApi.listPendingPermissions(directory),
    listPendingQuestions: (directory) => opencodeApi.listPendingQuestions(directory),
    listSessionMessages: (sessionId, options) => opencodeApi.listSessionMessages(sessionId, options),
    getSessionMessage: (sessionId, messageId, directory) => opencodeApi.getSessionMessage(sessionId, messageId, directory),
    getSessionTodos: (sessionId, directory) => opencodeApi.getSessionTodos(sessionId, directory),
    listPtys: (directory) => opencodeApi.listPtys(directory),
    createPty: (payload, options) => opencodeApi.createPty(payload, options),
    updatePtySize: (ptyId, payload) => opencodeApi.updatePtySize(ptyId, payload),
    deletePty: (ptyId, directory) => opencodeApi.deletePty(ptyId, directory),
    createPtyWebSocketUrl: (path, params, credentials) => opencodeApi.createWsUrl(path, params, credentials),
    sendCommand: (sessionId, payload) => opencodeApi.sendCommand(sessionId, payload),
    sendPromptAsync: (sessionId, payload) => opencodeApi.sendPromptAsync(sessionId, payload),
    abortSession: (sessionId, directory) => opencodeApi.abortSession(sessionId, directory),
    patchMessagePart: (payload) => opencodeApi.patchMessagePart(payload),
    replyPermission: (requestId, payload) => opencodeApi.replyPermission(requestId, payload),
    replyQuestion: (requestId, payload) => opencodeApi.replyQuestion(requestId, payload),
    rejectQuestion: (requestId, directory) => opencodeApi.rejectQuestion(requestId, directory),
    getGlobalHealth: () => opencodeApi.getGlobalHealth(),
    getMcpStatus: () => opencodeApi.getMcpStatus(),
    getLspStatus: () => opencodeApi.getLspStatus(),
    updateMcp: (payload) => opencodeApi.updateMcp(payload),
    getSkillStatus: () => opencodeApi.getSkillStatus(),
  };
}
