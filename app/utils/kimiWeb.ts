/**
 * Envelope-aware REST client for the kimi web server, reached through the
 * vis_bridge HTTP proxy root (e.g. `http://localhost:23004/kimi-web`).
 *
 * Wire types are intentionally snake_case: the kimi REST surface speaks
 * snake_case (`session_id`, `pending_interaction`, `agent_config`). Conversion
 * to the app's camelCase shapes happens in the backend adapter, not here.
 */

const JSON_CONTENT_TYPE = 'application/json';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type QueryValue = string | number | boolean | null | undefined;

export type KimiWebTokenProvider = () =>
  | string
  | null
  | undefined
  | Promise<string | null | undefined>;

export type KimiWebClientOptions = {
  /** Bridge HTTP proxy root, e.g. `http://localhost:23004/kimi-web`. */
  baseUrl: string;
  /** Bridge token provider; the kimi bearer never reaches the browser. */
  getToken?: KimiWebTokenProvider;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetcher?: typeof fetch;
};

/** Business error carrying the kimi envelope `code`/`msg`. */
export class KimiWebError extends Error {
  readonly code: number;
  readonly msg: string;

  constructor(code: number, msg: string) {
    super(msg);
    this.name = 'KimiWebError';
    this.code = code;
    this.msg = msg;
  }
}

export type KimiWebTransportKind = 'network' | 'malformed-response' | 'http-error';

/** Transport-level failure: network rejection, non-JSON body, or bare HTTP error. */
export class KimiWebTransportError extends Error {
  readonly kind: KimiWebTransportKind;
  readonly path: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: { kind: KimiWebTransportKind; path: string; status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = 'KimiWebTransportError';
    this.kind = options.kind;
    this.path = options.path;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export type KimiWebEnvelope<T> = {
  code: number;
  msg: string;
  data: T;
  request_id: string;
};

export type KimiWebPage<T> = {
  items: T[];
  has_more?: boolean;
};

export type KimiWebMeta = {
  server_version: string;
  server_id: string;
  backend: string;
  started_at?: string;
  capabilities: Record<string, boolean>;
  dangerous_bypass_auth: boolean;
  experimental_flags?: Record<string, boolean>;
  features?: Array<{ name: string; state: string; meta?: Record<string, unknown> }>;
  open_in_apps?: unknown[];
};

export type KimiWebAuth = {
  models_ready: boolean;
  providers_count?: number;
  managed_provider?: { name: string; status: string };
};

export type KimiWebModel = {
  provider: string;
  model: string;
  display_name: string;
  max_context_size?: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
};

export type KimiWebAgentConfig = {
  model: string;
  system_prompt?: string;
  tools?: string[];
  mcp_servers?: string[];
  thinking?: string;
  permission_mode?: 'manual' | 'yolo' | 'auto';
  plan_mode?: boolean;
  swarm_mode?: boolean;
  tower_mode?: boolean;
  tower_base?: string;
  goal_objective?: string;
  goal_control?: 'pause' | 'resume' | 'cancel';
};

export type KimiWebUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  context_tokens: number;
  context_limit: number;
  turn_count: number;
};

export type KimiWebPermissionRule = {
  id: string;
  tool_name: string;
  matcher?: { kind: 'command_prefix' | 'path_glob' | 'exact_input' | 'always'; value?: string };
  decision: 'approved';
  created_at: string;
  created_by: 'user' | 'agent';
};

export type KimiWebSession = {
  id: string;
  workspace_id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  busy: boolean;
  main_turn_active: boolean;
  pending_interaction: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  archived: boolean;
  archived_at?: string | null;
  current_prompt_id?: string;
  last_prompt?: string;
  metadata?: { cwd: string };
  agent_config?: KimiWebAgentConfig;
  usage?: KimiWebUsage;
  permission_rules?: KimiWebPermissionRule[];
  message_count?: number;
  last_seq?: number;
};

export type KimiWebMediaSource =
  | { kind: 'url'; url: string; id?: string }
  | { kind: 'base64'; media_type: string; data: string }
  | { kind: 'file'; file_id: string }
  | { kind: 'session_media'; file_id: string }
  | { kind: 'path'; path: string };

export type KimiWebContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: 'image'; source: KimiWebMediaSource; name?: string }
  | { type: 'video'; source: KimiWebMediaSource; name?: string }
  | {
      type: 'file';
      file_id?: string;
      path?: string;
      name?: string;
      media_type?: string;
      size?: number;
    };

export type KimiWebMessageOrigin = {
  kind?: 'user' | 'injection';
  [key: string]: unknown;
};

export type KimiWebMessage = {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: KimiWebContentPart[];
  created_at?: string;
  prompt_id?: string;
  parent_message_id?: string;
  /** Full path is `metadata.origin.kind` (injection vs user). */
  metadata?: { origin?: KimiWebMessageOrigin };
};

export type KimiWebPromptAccepted = {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued' | 'blocked';
  content?: KimiWebContentPart[];
};

export type KimiWebSteerResult = { steered: true; prompt_ids: string[] };

export type KimiWebAbortPromptResult = { aborted: boolean; at_seq?: number };

export type KimiWebApproval = {
  approval_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id?: string;
  tool_name?: string;
  action?: string;
  tool_input_display?: unknown;
  created_at?: string;
  expires_at?: string | null;
};

export type KimiWebQuestionItem = {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  multi_select?: boolean;
  allow_other?: boolean;
  other_label?: string;
  other_description?: string;
};

export type KimiWebQuestion = {
  question_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id?: string;
  questions?: KimiWebQuestionItem[];
  created_at?: string;
};

export type KimiWebQuestionAnswer =
  | { kind: 'single'; option_id: string }
  | { kind: 'multi'; option_ids: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multi_with_other'; option_ids: string[]; other_text: string }
  | { kind: 'skipped' };

export type KimiWebAnswerApprovalInput = {
  decision: 'approved' | 'rejected' | 'cancelled';
  scope?: 'session';
  feedback?: string;
  selected_label?: string;
};

export type KimiWebAnswerQuestionInput = {
  answers: Record<string, KimiWebQuestionAnswer>;
  method?: 'enter' | 'space' | 'number_key' | 'click';
  note?: string;
};

export type KimiWebResolved = { resolved: true; resolved_at?: string };

export type KimiWebSessionStatus = {
  busy: boolean;
  model?: string;
  thinking_level?: string;
  permission?: string;
  plan_mode?: boolean;
  swarm_mode?: boolean;
  tower_mode?: boolean;
  context_tokens?: number;
  max_context_tokens?: number;
  context_usage?: number;
};

export type KimiWebSubagent = {
  id: string;
  session_id: string;
  kind: 'subagent' | 'bash' | 'tool';
  description?: string;
  status?: string;
  command?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
  model?: string;
  thinking_effort?: string;
  agent_id?: string;
  subagent_type?: string;
  parent_tool_call_id?: string;
  run_in_background?: boolean;
  subagent_phase?: string;
  suspended_reason?: string;
  swarm_index?: number;
};

export type KimiWebSnapshot = {
  as_of_seq: number;
  epoch: string;
  session: KimiWebSession;
  messages: KimiWebPage<KimiWebMessage>;
  in_flight_turn?: {
    turn_id: number;
    assistant_text?: string;
    thinking_text?: string;
    running_tools?: unknown[];
    current_prompt_id?: string;
  } | null;
  subagents?: KimiWebSubagent[];
  pending_approvals?: KimiWebApproval[];
  pending_questions?: KimiWebQuestion[];
};

export type KimiWebUploadedFile = {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at?: string;
  expires_at?: string | null;
};

export type KimiWebCreateSessionInput = {
  title?: string;
  metadata?: { cwd: string };
  agent_config?: KimiWebAgentConfig;
  workspace_id?: string;
};

export type KimiWebSessionProfileInput = {
  title?: string;
  metadata?: { cwd: string };
  agent_config?: Partial<KimiWebAgentConfig>;
  permission_rules?: KimiWebPermissionRule[];
};

export type KimiWebSendPromptInput = { content: KimiWebContentPart[] };

export type KimiWebListSessionsOptions = {
  before_id?: string;
  after_id?: string;
  page_size?: number;
  busy?: boolean;
  include_archive?: boolean;
  exclude_empty?: boolean;
  archived_only?: boolean;
  workspace_id?: string;
  signal?: AbortSignal;
};

export type KimiWebGetMessagesOptions = {
  /**
   * Plan-level pagination cursor. The live 0.43.0 server ignores unknown
   * query keys, so this rides alongside the authoritative `before_id`/
   * `after_id`/`page_size` pair without breaking the request.
   */
  cursor?: string;
  before_id?: string;
  after_id?: string;
  page_size?: number;
  role?: 'user' | 'assistant' | 'tool' | 'system';
  signal?: AbortSignal;
};

export type KimiWebListOptions = { signal?: AbortSignal };

export type KimiWebFsEntry = {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  modified_at: string;
  etag: string;
  size?: number;
};

export type KimiWebFsList = {
  items: KimiWebFsEntry[];
  truncated: boolean;
};

export type KimiWebGitStatus = {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, unknown>;
  additions: number;
  deletions: number;
  pullRequest?: { number: number; state: string; url: string } | null;
};

export type KimiWebDownloadFileOptions = { runtime_id?: string; signal?: AbortSignal };

export type KimiWebUploadFileInput = {
  file: Blob;
  name?: string;
  expires_in_sec?: number;
};

type RequestSpec = {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildQuery(params?: Record<string, QueryValue>): string {
  if (!params) return '';
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

function encodeFilePath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function unwrapEnvelope(text: string, path: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new KimiWebTransportError(`Kimi Web returned a non-JSON body for ${path}.`, {
      kind: 'malformed-response',
      path,
      cause,
    });
  }
  if (!isRecord(parsed) || typeof parsed.code !== 'number') {
    throw new KimiWebTransportError(`Kimi Web returned an invalid envelope for ${path}.`, {
      kind: 'malformed-response',
      path,
    });
  }
  if (parsed.code !== 0) {
    const msg =
      typeof parsed.msg === 'string' && parsed.msg
        ? parsed.msg
        : `Kimi Web request failed (code ${parsed.code}).`;
    throw new KimiWebError(parsed.code, msg);
  }
  return parsed.data;
}

async function readBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

export function createKimiWebClient(options: KimiWebClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const getToken = options.getToken;
  const fetcher = options.fetcher ?? fetch;

  async function send(spec: RequestSpec): Promise<Response> {
    const headers: Record<string, string> = {};
    const token = (await getToken?.())?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (spec.body !== undefined) headers['Content-Type'] = JSON_CONTENT_TYPE;
    const url = `${baseUrl}${spec.path}${buildQuery(spec.query)}`;
    try {
      return await fetcher(url, {
        method: spec.method,
        headers,
        body: spec.formData ?? (spec.body === undefined ? undefined : JSON.stringify(spec.body)),
        signal: spec.signal,
      });
    } catch (cause) {
      throw new KimiWebTransportError(`Kimi Web request failed: ${spec.method} ${spec.path}`, {
        kind: 'network',
        path: spec.path,
        cause,
      });
    }
  }

  async function rejectHttp(response: Response, path: string): Promise<never> {
    const text = await response.text().catch(() => '');
    if (text.trim()) {
      try {
        unwrapEnvelope(text, path);
      } catch (cause) {
        if (cause instanceof KimiWebError) throw cause;
      }
    }
    throw new KimiWebTransportError(
      `Kimi Web request failed (${response.status}) for ${path}.`,
      { kind: 'http-error', path, status: response.status },
    );
  }

  /** Status-first: 204 is empty success, 206/304 return bytes, 200/201 unwrap. */
  async function requestJson<T>(spec: RequestSpec): Promise<T> {
    const response = await send(spec);
    const { status } = response;
    if (status === 204) return undefined as unknown as T;
    if (status === 206 || status === 304) return (await readBytes(response)) as unknown as T;
    if (status === 200 || status === 201) {
      const text = await response.text();
      if (!text.trim()) return undefined as unknown as T;
      return unwrapEnvelope(text, spec.path) as T;
    }
    return rejectHttp(response, spec.path);
  }

  async function requestBytes(spec: RequestSpec): Promise<Uint8Array> {
    const response = await send(spec);
    const { status } = response;
    if (status === 204) return new Uint8Array();
    if (status === 206 || status === 304) return readBytes(response);
    if (status === 200 || status === 201) {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes(JSON_CONTENT_TYPE)) {
        const text = await response.text();
        // A JSON error envelope on a download endpoint still throws KimiWebError.
        if (text.trim()) unwrapEnvelope(text, spec.path);
        throw new KimiWebTransportError(
          `Kimi Web binary endpoint returned JSON for ${spec.path}.`,
          { kind: 'malformed-response', path: spec.path },
        );
      }
      return readBytes(response);
    }
    return rejectHttp(response, spec.path);
  }

  const sessionPath = (sessionId: string) =>
    `/api/v1/sessions/${encodeURIComponent(sessionId)}`;

  const sessionFsAction = <T>(
    sessionId: string,
    action: 'list' | 'git_status',
    body: unknown,
    signal?: AbortSignal,
  ) =>
    requestJson<T>({
      method: 'POST',
      path: `${sessionPath(sessionId)}/fs:${action}`,
      body,
      signal,
    });

  return {
    getMeta: () => requestJson<KimiWebMeta>({ method: 'GET', path: '/api/v1/meta' }),
    getAuth: () => requestJson<KimiWebAuth>({ method: 'GET', path: '/api/v1/auth' }),
    listModels: () =>
      requestJson<KimiWebPage<KimiWebModel>>({ method: 'GET', path: '/api/v1/models' }),

    createSession: (input: KimiWebCreateSessionInput) =>
      requestJson<KimiWebSession>({ method: 'POST', path: '/api/v1/sessions', body: input }),
    updateProfile: (sessionId: string, input: KimiWebSessionProfileInput) =>
      requestJson<KimiWebSession>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/profile`,
        body: input,
      }),
    listSessions: (listOptions: KimiWebListSessionsOptions = {}) => {
      const { signal, ...query } = listOptions;
      return requestJson<KimiWebPage<KimiWebSession>>({
        method: 'GET',
        path: '/api/v1/sessions',
        query,
        signal,
      });
    },
    deleteSession: (sessionId: string) =>
      requestJson<void>({ method: 'POST', path: `${sessionPath(sessionId)}:delete` }),
    archiveSession: (sessionId: string) =>
      requestJson<KimiWebSession>({ method: 'POST', path: `${sessionPath(sessionId)}:archive` }),
    restoreSession: (sessionId: string) =>
      requestJson<KimiWebSession>({ method: 'POST', path: `${sessionPath(sessionId)}:restore` }),

    getMessages: (sessionId: string, getOptions: KimiWebGetMessagesOptions = {}) => {
      const { signal, ...query } = getOptions;
      return requestJson<KimiWebPage<KimiWebMessage>>({
        method: 'GET',
        path: `${sessionPath(sessionId)}/messages`,
        query,
        signal,
      });
    },
    sendPrompt: (sessionId: string, input: KimiWebSendPromptInput) =>
      requestJson<KimiWebPromptAccepted>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/prompts`,
        body: input,
      }),
    steer: (sessionId: string, promptIds: string[]) =>
      requestJson<KimiWebSteerResult>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/prompts:steer`,
        body: { prompt_ids: promptIds },
      }),
    abortPrompt: (sessionId: string, promptId: string) =>
      requestJson<KimiWebAbortPromptResult>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      }),
    abortSession: (sessionId: string) =>
      requestJson<KimiWebSession | undefined>({
        method: 'POST',
        path: `${sessionPath(sessionId)}:abort`,
      }),

    listApprovals: (sessionId: string, listOptions: KimiWebListOptions = {}) =>
      requestJson<{ items: KimiWebApproval[] }>({
        method: 'GET',
        path: `${sessionPath(sessionId)}/approvals`,
        query: { status: 'pending' },
        signal: listOptions.signal,
      }),
    answerApproval: (sessionId: string, approvalId: string, answer: KimiWebAnswerApprovalInput) =>
      requestJson<KimiWebResolved>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
        body: answer,
      }),
    listQuestions: (sessionId: string, listOptions: KimiWebListOptions = {}) =>
      requestJson<{ items: KimiWebQuestion[] }>({
        method: 'GET',
        path: `${sessionPath(sessionId)}/questions`,
        query: { status: 'pending' },
        signal: listOptions.signal,
      }),
    answerQuestion: (sessionId: string, questionId: string, answer: KimiWebAnswerQuestionInput) =>
      requestJson<KimiWebResolved | null>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/questions/${encodeURIComponent(questionId)}`,
        body: answer,
      }),
    dismissQuestion: (sessionId: string, questionId: string) =>
      requestJson<KimiWebResolved | null>({
        method: 'POST',
        path: `${sessionPath(sessionId)}/questions/${encodeURIComponent(questionId)}:dismiss`,
      }),

    getSessionStatus: (sessionId: string) =>
      requestJson<KimiWebSessionStatus>({
        method: 'GET',
        path: `${sessionPath(sessionId)}/status`,
      }),
    getSnapshot: (sessionId: string) =>
      requestJson<KimiWebSnapshot>({ method: 'GET', path: `${sessionPath(sessionId)}/snapshot` }),

    listFiles: (sessionId: string, path = '.', listOptions: KimiWebListOptions = {}) =>
      sessionFsAction<KimiWebFsList>(sessionId, 'list', { path }, listOptions.signal),
    getGitStatus: (sessionId: string, listOptions: KimiWebListOptions = {}) =>
      sessionFsAction<KimiWebGitStatus>(sessionId, 'git_status', {}, listOptions.signal),

    uploadFile: (input: KimiWebUploadFileInput) => {
      const formData = new FormData();
      formData.append('file', input.file, input.name);
      if (input.name !== undefined) formData.append('name', input.name);
      if (input.expires_in_sec !== undefined) {
        formData.append('expires_in_sec', String(input.expires_in_sec));
      }
      return requestJson<KimiWebUploadedFile>({
        method: 'POST',
        path: '/api/v1/files',
        formData,
      });
    },
    downloadFile: (
      sessionId: string,
      filePath: string,
      downloadOptions: KimiWebDownloadFileOptions = {},
    ) =>
      requestBytes({
        method: 'GET',
        path: `${sessionPath(sessionId)}/fs/${encodeFilePath(filePath)}:download`,
        query: { runtime_id: downloadOptions.runtime_id },
        signal: downloadOptions.signal,
      }),
  };
}

export type KimiWebClient = ReturnType<typeof createKimiWebClient>;
