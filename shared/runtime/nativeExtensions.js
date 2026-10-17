/** Legacy adapter operations retained at the harness boundary, not workspace services. */
const groups = {
  session: ['forkSession', 'updateSession', 'deleteSession', 'revertSession', 'unrevertSession', 'getSessionDiff', 'getSessionChildren', 'syncSessionConfig', 'getSessionMessage', 'getSessionTodos', 'sendCommand', 'patchMessagePart', 'getPermissionPresetOptions', 'selectPermissionPreset'],
  settings: ['getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'batchWriteConfig', 'getSessionConfigOptions'],
  providers: ['listProviders', 'listProviderAuthMethods', 'authorizeProviderOAuth', 'completeProviderOAuth', 'setProviderAuth', 'deleteProviderAuth'],
  auth: ['listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent'],
  commands: ['listCommands'],
  status: ['getSessionStatusMap', 'listPendingPermissions', 'listPendingQuestions', 'getLspStatus', 'getPluginStatus', 'getPluginManagementEntries', 'setPluginEnabled'],
  mcp: ['getMcpStatus', 'updateMcp'],
  skills: ['getSkillStatus', 'updateSkill'],
};
export const NATIVE_EXTENSIONS = Object.freeze(Object.fromEntries(Object.entries(groups).flatMap(([group, methods]) => methods.map((method) => [method, Object.freeze({ group, scope: group === 'session' ? 'session' : 'instance' })]))));

export const WORKSPACE_OPERATIONS = Object.freeze({
  updateProject: 'git', createWorktree: 'git', deleteWorktree: 'git', getPathInfo: 'git',
  listProjects: 'git', getCurrentProject: 'git', listWorktrees: 'git', getVcsInfo: 'git',
  listFiles: 'files', readFileContent: 'files', readFileContentBytes: 'files', writeFileContent: 'files',
  listPtys: 'terminal', createPty: 'terminal', updatePtySize: 'terminal', deletePty: 'terminal',
  createPtyWebSocketUrl: 'terminal', runOneShotCommand: 'terminal',
});
const core = {
  configure: 'configuration', disconnect: 'close', createSession: 'createSession',
  listSessions: 'listSessionPage', getSession: 'getSession', listSessionMessages: 'readHistoryPage',
  sendPromptAsync: 'send', abortSession: 'cancel', replyPermission: 'respondInteraction',
  replyQuestion: 'respondInteraction', rejectQuestion: 'respondInteraction', getGlobalHealth: 'inspect',
};
/** configure belongs to construction, not the ten-method runtime interface.
 * createAgentAuthPty is native authentication which may delegate to workspace PTY.
 * getSessionDiff is session-attributed change data; getLspStatus is native harness status.
 */
export const BACKEND_OPERATION_OWNERS = Object.freeze(Object.fromEntries([
  ...Object.entries(core).map(([name, operation]) => [name, Object.freeze({ owner: operation === 'configuration' ? 'configuration' : 'core', operation })]),
  ...Object.entries(WORKSPACE_OPERATIONS).map(([name, service]) => [name, Object.freeze({ owner: 'workspace', service, operation: name })]),
  ...Object.keys(NATIVE_EXTENSIONS).map((name) => [name, Object.freeze({ owner: 'native', operation: name })]),
]));

/** Compatibility identifiers are preserved, but method presence never proves semantics
 * (notably updateSession may implement rename without pin). Drivers declare each bit.
 * Kimi/DSH send and history come from source bridges, not adapter-method absence.
 */
export const LEGACY_CAPABILITIES = Object.freeze(Object.fromEntries(Object.entries({
  projects: ['workspace', 'listProjects'], worktrees: ['workspace', 'listWorktrees'],
  files: ['workspace', 'listFiles'], terminal: ['workspace', 'createPty'],
  sessions: ['core', 'listSessionPage'], permissions: ['core', 'respondInteraction'], questions: ['core', 'respondInteraction'],
  sessionFork: ['native', 'forkSession'], sessionRevert: ['native', 'revertSession'],
  sessionRename: ['native', 'updateSession'], sessionArchive: ['native', 'updateSession'],
  sessionUnarchive: ['native', 'updateSession'], sessionDelete: ['native', 'deleteSession'],
  sessionPin: ['native', 'updateSession'], sessionUnpin: ['native', 'updateSession'],
  sessionCompact: ['native', 'compactSession'], todos: ['native', 'getSessionTodos'],
  status: ['native', 'getSessionStatusMap'], providerConfig: ['native', 'getGlobalConfig'],
  imageAttachmentsOnly: ['behavior'], projectPickerCreatesSession: ['behavior'],
  ptyExitRequiresSyntheticEvent: ['workspace'], ptyRefreshArtifactsOnSuccess: ['workspace'],
  strictSandboxPaths: ['workspace'], sessionManagementMode: ['behavior'],
}).map(([name, [owner, operation]]) => [name, Object.freeze({ owner, ...(operation ? { operation } : {}) })])));
