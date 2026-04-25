import {
  CodexJsonRpcClient,
  type CodexJsonRpcClientOptions,
  type CodexJsonRpcId,
  type CodexJsonRpcNotification,
  type CodexJsonRpcServerRequest,
} from './jsonRpcClient';

export type CodexClientInfo = {
  name: string;
  title: string;
  version: string;
};

export type CodexInitializeParams = {
  clientInfo?: CodexClientInfo;
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
};

export type CodexInitializeResult = {
  userAgent?: string;
  platformFamily?: string;
  platformOs?: string;
};

export type CodexThread = {
  id: string;
  name?: string | null;
  preview?: string;
  ephemeral?: boolean;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: unknown;
};

export type CodexThreadListParams = {
  cursor?: string | null;
  limit?: number;
  sortKey?: 'created_at' | 'updated_at';
  modelProviders?: string[] | null;
  sourceKinds?: string[];
  archived?: boolean;
  cwd?: string;
  searchTerm?: string;
};

export type CodexThreadListResult = {
  data: CodexThread[];
  nextCursor: string | null;
};

export type CodexThreadStartParams = {
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  personality?: string;
  serviceName?: string;
};

export type CodexThreadStartResult = {
  thread: CodexThread;
};

export type CodexThreadResumeParams = {
  threadId: string;
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  personality?: string;
};

export type CodexThreadResumeResult = {
  thread: CodexThread;
};

export type CodexThreadNameSetParams = {
  threadId: string;
  name: string | null;
};

export type CodexThreadArchiveParams = {
  threadId: string;
};

export type CodexThreadUnarchiveResult = {
  thread: CodexThread;
};

export type CodexThreadUnsubscribeParams = {
  threadId: string;
};

export type CodexThreadReadParams = {
  threadId: string;
  includeTurns?: boolean;
};

export type CodexThreadReadResult = {
  thread: CodexThread & {
    turns?: CodexTurn[];
  };
};

export type CodexTurnInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string };

export type CodexTurnStartParams = {
  threadId: string;
  input: CodexTurnInputItem[];
  cwd?: string;
  approvalPolicy?: string;
  sandboxPolicy?: unknown;
  model?: string;
  effort?: string;
  summary?: string;
  personality?: string;
  outputSchema?: unknown;
};

export type CodexTurn = {
  id: string;
  status?: string;
  items?: unknown[];
  error?: unknown;
};

export type CodexThreadTurnsListParams = {
  threadId: string;
  cursor?: string | null;
  limit?: number;
  sortDirection?: 'asc' | 'desc';
};

export type CodexThreadTurnsListResult = {
  data: CodexTurn[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};

export type CodexTurnStartResult = {
  turn: CodexTurn;
};

export type CodexTurnInterruptParams = {
  threadId: string;
  turnId: string;
};

export type CodexPromptInput = Omit<CodexTurnStartParams, 'threadId' | 'input'> & {
  threadId?: string;
  text: string;
  thread?: CodexThreadStartParams;
};

export type CodexPromptResult = {
  threadId: string;
  thread?: CodexThread;
  turn: CodexTurn;
};

export type CodexAdapterOptions = CodexJsonRpcClientOptions & {
  clientInfo?: CodexClientInfo;
  experimentalApi?: boolean;
};

function defaultClientInfo(): CodexClientInfo {
  return {
    name: 'vis',
    title: 'Vis',
    version: '0.3.0',
  };
}

export class CodexAdapter {
  readonly kind = 'codex' as const;
  readonly label = 'Codex';
  readonly capabilities = {
    projects: false,
    worktrees: false,
    sessions: true,
    sessionFork: false,
    sessionRevert: false,
  };

  private readonly client: CodexJsonRpcClient;
  private readonly clientInfo: CodexClientInfo;
  private readonly experimentalApi: boolean;
  private initialized = false;

  constructor(options: CodexAdapterOptions) {
    this.client = new CodexJsonRpcClient(options);
    this.clientInfo = options.clientInfo ?? defaultClientInfo();
    this.experimentalApi = options.experimentalApi ?? false;
  }

  isConnected() {
    return this.client.isConnected();
  }

  connect() {
    return this.client.connect();
  }

  disconnect() {
    this.initialized = false;
    this.client.disconnect();
  }

  onNotification(handler: (notification: CodexJsonRpcNotification) => void) {
    return this.client.onNotification(handler);
  }

  onServerRequest(handler: (request: CodexJsonRpcServerRequest) => void) {
    return this.client.onServerRequest(handler);
  }

  respondToServerRequest(id: CodexJsonRpcId, result: unknown) {
    this.client.respond(id, result);
  }

  async initialize(params: CodexInitializeParams = {}) {
    await this.connect();
    const capabilities = params.capabilities ?? {
      experimentalApi: this.experimentalApi,
    };
    const result = await this.client.request<CodexInitializeResult>('initialize', {
      clientInfo: params.clientInfo ?? this.clientInfo,
      capabilities,
    });
    this.client.notify('initialized', {});
    this.initialized = true;
    return result;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    await this.initialize();
  }

  async listThreads(params: CodexThreadListParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadListResult>('thread/list', params);
  }

  async startThread(params: CodexThreadStartParams = {}) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadStartResult>('thread/start', params);
  }

  async resumeThread(params: CodexThreadResumeParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadResumeResult>('thread/resume', params);
  }

  async setThreadName(params: CodexThreadNameSetParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('thread/name/set', params);
  }

  async archiveThread(params: CodexThreadArchiveParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('thread/archive', params);
  }

  async unarchiveThread(params: CodexThreadArchiveParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadUnarchiveResult>('thread/unarchive', params);
  }

  async unsubscribeThread(params: CodexThreadUnsubscribeParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('thread/unsubscribe', params);
  }

  async readThread(params: CodexThreadReadParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadReadResult>('thread/read', params);
  }

  async listThreadTurns(params: CodexThreadTurnsListParams) {
    await this.ensureInitialized();
    return this.client.request<CodexThreadTurnsListResult>('thread/turns/list', params);
  }

  async startTurn(params: CodexTurnStartParams) {
    await this.ensureInitialized();
    return this.client.request<CodexTurnStartResult>('turn/start', params);
  }

  async interruptTurn(params: CodexTurnInterruptParams) {
    await this.ensureInitialized();
    return this.client.request<{}>('turn/interrupt', params);
  }

  async sendPrompt(input: CodexPromptInput): Promise<CodexPromptResult> {
    await this.ensureInitialized();
    const startedThread = input.threadId
      ? undefined
      : await this.startThread({
          ...input.thread,
          model: input.thread?.model ?? input.model,
          cwd: input.thread?.cwd ?? input.cwd,
          approvalPolicy: input.thread?.approvalPolicy ?? input.approvalPolicy,
        });
    const threadId = input.threadId ?? startedThread?.thread.id;
    if (!threadId) {
      throw new Error('Codex prompt requires a threadId or a started thread.');
    }
    if (input.threadId) {
      await this.resumeThread({ threadId: input.threadId });
    }

    const turn = await this.startTurn({
      threadId,
      input: [{ type: 'text', text: input.text }],
      cwd: input.cwd,
      approvalPolicy: input.approvalPolicy,
      sandboxPolicy: input.sandboxPolicy,
      model: input.model,
      effort: input.effort,
      summary: input.summary,
      personality: input.personality,
      outputSchema: input.outputSchema,
    });

    return {
      threadId,
      thread: startedThread?.thread,
      turn: turn.turn,
    };
  }
}

export function createCodexAdapter(options: CodexAdapterOptions) {
  return new CodexAdapter(options);
}
