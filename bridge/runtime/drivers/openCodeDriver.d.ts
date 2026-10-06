import type { HarnessRegistration } from '../../../shared/runtime/harnessContract.js';
import type { EnvironmentId, HarnessInstanceId } from '../../../shared/runtime/identity.js';
import type { RuntimeStore, Json } from '../storage/runtimeStore.js';
import type { RuntimeHost } from '../runtimeHost.js';
export interface OpenCodeDriverOptions {
  readonly environmentId: EnvironmentId; readonly harnessInstanceId: HarnessInstanceId;
  readonly epoch: string; readonly processGeneration: number;
  /** Server-side endpoint and authorization. Never include these in the manifest or events. */
  readonly endpoint: string; readonly authorization?: string;
  readonly store: RuntimeStore; readonly runtime: RuntimeHost;
  readonly currentProcess: () => { readonly epoch: string; readonly processGeneration: number };
  /** Trusted local path returned by `opencode db path` for this process's exact state environment. */
  readonly officialStorePath?: string;
  readonly resolveCredential?: (reference: string) => Promise<Json>;
  readonly requestTimeoutMs?: number; readonly eventBufferBytes?: number;
}
export interface OpenCodeDriver {
  readonly registration: HarnessRegistration;
  readonly nativeVersion: string; readonly bufferedBytes: number;
  close(): Promise<void>; retryDiscovery(): Promise<void>;
}
export function createOpenCodeDriver(options: OpenCodeDriverOptions): Promise<OpenCodeDriver>;
