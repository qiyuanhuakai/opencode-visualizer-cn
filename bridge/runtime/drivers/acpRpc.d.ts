import type { AcpRuntimeProcessManager } from '../../acpProcessManager.js';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';
export type AcpObject = { readonly [key: string]: JsonValue };
export interface AcpMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: JsonValue;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
}
export interface AcpRpc {
  request(
    method: string,
    params: JsonValue,
    options?: { readonly control?: boolean },
  ): Promise<JsonValue>;
  reply(id: string | number, result: JsonValue): void;
  notify(method: string, params: JsonValue): void;
  assertCurrent(): void;
  readonly active: boolean;
  readonly processGeneration: number;
  readonly pid: number;
  close(): Promise<void>;
}
export function createAcpRpc(options: {
  readonly manager: AcpRuntimeProcessManager;
  readonly agentId: string;
  readonly onRequest: (
    message: AcpMessage & { readonly id: string | number; readonly method: string },
  ) => Promise<void>;
  readonly onNotification: (message: AcpMessage & { readonly method: string }) => void;
  readonly onExit: () => void;
  readonly onOutgoing?: (message: AcpMessage) => void;
  readonly onResult?: (message: AcpMessage) => void;
  readonly deadlineMs?: number;
}): AcpRpc;
