import { CodexJsonRpcError } from './jsonRpcProtocol';

export type CodexOverloadRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type CodexRequestOptions = {
  retryOverloaded?: CodexOverloadRetryPolicy;
};

export type CodexIdempotentMethod =
  | 'account/rateLimits/read'
  | 'account/read'
  | 'account/usage/read'
  | 'app/list'
  | 'collaborationMode/list'
  | 'config/read'
  | 'configRequirements/read'
  | 'experimentalFeature/list'
  | 'externalAgentConfig/detect'
  | 'fs/getMetadata'
  | 'fs/readDirectory'
  | 'fs/readFile'
  | 'mcpServer/resource/read'
  | 'mcpServerStatus/list'
  | 'model/list'
  | 'modelProvider/capabilities/read'
  | 'permissionProfile/list'
  | 'plugin/list'
  | 'plugin/read'
  | 'skills/list'
  | 'thread/goal/get'
  | 'thread/list'
  | 'thread/loaded/list'
  | 'thread/read'
  | 'thread/turns/list';

export const CODEX_IDEMPOTENT_RETRY_OPTIONS = {
  retryOverloaded: {
    maxAttempts: 4,
    baseDelayMs: 250,
    maxDelayMs: 4_000,
  },
} satisfies CodexRequestOptions;

function retryAfterMs(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const value = record.retryAfterMs ?? record.retry_after_ms;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function isCodexOverload(error: unknown): error is CodexJsonRpcError {
  return error instanceof CodexJsonRpcError && error.code === -32001;
}

export function overloadRetryDelayMs(
  error: CodexJsonRpcError,
  failedAttempt: number,
  policy: CodexOverloadRetryPolicy,
) {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
  );
  const jittered = Math.round(exponential * (0.75 + Math.random() * 0.5));
  return Math.max(retryAfterMs(error.data) ?? 0, jittered);
}

export function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
