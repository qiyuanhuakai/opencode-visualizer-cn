import { CodexJsonRpcError } from './jsonRpcClient';

export function isUnmaterializedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /not materialized/i.test(message) ||
    /includeTurns is unavailable/i.test(message) ||
    /no rollout found/i.test(message)
  );
}

export function isUnsupportedCodexMethodError(error: unknown): error is CodexJsonRpcError {
  return error instanceof CodexJsonRpcError && error.code === -32601;
}

export function isUnsupportedResumeHistoryError(error: unknown): error is CodexJsonRpcError {
  return (
    isUnsupportedCodexMethodError(error) &&
    /(?:list_turns|thread\/turns\/list).*(?:not supported|unsupported)/iu.test(error.message)
  );
}
