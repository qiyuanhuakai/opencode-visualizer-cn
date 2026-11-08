import type { HarnessRegistration, HarnessScope } from '../../../shared/runtime/harnessContract.js';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';
import type { RuntimeHost } from '../runtimeHost.js';
import type { RuntimeStore } from '../storage/runtimeStore.js';
import type { OperationJournal } from '../operationJournal.js';
import type { InteractionStore } from '../interactionStore.js';
import type { createWorkspaceService } from '../workspaceService.js';
import type { NativeTransport } from '../../../shared/runtime/native/codex/appServerClient.js';
import type { createCodexProcess } from './codexProcess.js';
export type CodexDriverOptions = HarnessScope & {
  readonly epoch: string;
  readonly processGeneration: number;
  readonly store: RuntimeStore;
  readonly runtime: RuntimeHost;
  readonly workspace: Awaited<ReturnType<typeof createWorkspaceService>>;
  readonly allowedWorkspaces: readonly string[];
  readonly transport?: NativeTransport;
  readonly process?: Parameters<typeof createCodexProcess>[0];
  readonly isProcessCurrent: (
    scope: HarnessScope & { readonly epoch: string; readonly processGeneration: number },
  ) => boolean;
  readonly credentialValues?: readonly string[];
  readonly resolveCredential?: (
    ref: string,
    context: HarnessScope & Readonly<Record<string, unknown>>,
  ) => Promise<JsonValue>;
  readonly onError?: (error: Error) => void;
};
export type CodexDriver = {
  readonly registration: HarnessRegistration;
  readonly protocolProfile: '0.160.0';
  readonly journal: OperationJournal;
  readonly interactions: InteractionStore;
  close(): Promise<void>;
};
export function createCodexDriver(options: CodexDriverOptions): Promise<CodexDriver>;
