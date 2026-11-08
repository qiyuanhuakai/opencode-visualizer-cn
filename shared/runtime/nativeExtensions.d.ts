export type NativeOperation = 'forkSession' | 'updateSession' | 'deleteSession' | 'revertSession' | 'unrevertSession'
  | 'getSessionDiff' | 'getSessionChildren' | 'syncSessionConfig' | 'getSessionMessage' | 'getSessionTodos'
  | 'sendCommand' | 'patchMessagePart' | 'getPermissionPresetOptions' | 'selectPermissionPreset'
  | 'getGlobalConfig' | 'updateGlobalConfig' | 'writeConfigValue' | 'batchWriteConfig' | 'getSessionConfigOptions'
  | 'listProviders' | 'listProviderAuthMethods' | 'authorizeProviderOAuth' | 'completeProviderOAuth'
  | 'setProviderAuth' | 'deleteProviderAuth' | 'listAgents' | 'listAgentAuthMethods' | 'createAgentAuthPty'
  | 'authenticateAgent' | 'listCommands' | 'getSessionStatusMap' | 'listPendingPermissions' | 'listPendingQuestions'
  | 'getLspStatus' | 'getPluginStatus' | 'getPluginManagementEntries' | 'setPluginEnabled' | 'getMcpStatus'
  | 'updateMcp' | 'getSkillStatus' | 'updateSkill';
export type WorkspaceOperation = 'updateProject' | 'createWorktree' | 'deleteWorktree' | 'getPathInfo'
  | 'listProjects' | 'getCurrentProject' | 'listWorktrees' | 'getVcsInfo' | 'listFiles' | 'readFileContent'
  | 'readFileContentBytes' | 'writeFileContent' | 'listPtys' | 'createPty' | 'updatePtySize' | 'deletePty'
  | 'createPtyWebSocketUrl' | 'runOneShotCommand';
export type LegacyCoreOperation = 'configure' | 'disconnect' | 'createSession' | 'listSessions' | 'getSession'
  | 'listSessionMessages' | 'sendPromptAsync' | 'abortSession' | 'replyPermission' | 'replyQuestion' | 'rejectQuestion' | 'getGlobalHealth';
export type LegacyCapability = 'projects' | 'worktrees' | 'files' | 'terminal' | 'sessions' | 'permissions' | 'questions'
  | 'sessionFork' | 'sessionRevert' | 'sessionRename' | 'sessionArchive' | 'sessionUnarchive' | 'sessionDelete'
  | 'sessionPin' | 'sessionUnpin' | 'sessionCompact' | 'todos' | 'status' | 'providerConfig'
  | 'imageAttachmentsOnly' | 'projectPickerCreatesSession' | 'ptyExitRequiresSyntheticEvent'
  | 'ptyRefreshArtifactsOnSuccess' | 'strictSandboxPaths' | 'sessionManagementMode';
export type OperationOwner =
  | { readonly owner: 'configuration'; readonly operation: 'configuration' }
  | { readonly owner: 'workspace'; readonly service: 'git' | 'files' | 'terminal'; readonly operation: WorkspaceOperation }
  | { readonly owner: 'core'; readonly operation: string }
  | { readonly owner: 'native'; readonly operation: NativeOperation };
export const BACKEND_OPERATION_OWNERS: Readonly<Record<NativeOperation | WorkspaceOperation | LegacyCoreOperation, OperationOwner>>;
export const WORKSPACE_OPERATIONS: Readonly<Record<WorkspaceOperation, 'git' | 'files' | 'terminal'>>;
export const NATIVE_EXTENSIONS: Readonly<Record<NativeOperation, { readonly group: 'session' | 'settings' | 'providers' | 'auth' | 'commands' | 'status' | 'mcp' | 'skills'; readonly scope: 'session' | 'instance' }>>;
export const LEGACY_CAPABILITIES: Readonly<Record<LegacyCapability, { readonly owner: 'workspace' | 'core' | 'native' | 'behavior'; readonly operation?: string }>>;
