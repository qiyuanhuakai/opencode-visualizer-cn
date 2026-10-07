import type { AcpRuntimeProcessManager } from '../../acpProcessManager.js';
import type { RuntimeStore } from '../storage/runtimeStore.js';
import type { createWorkspaceService } from '../workspaceService.js';
import type { HarnessRegistration } from '../../../shared/runtime/harnessContract.js';
import type { AcpBinding } from './acpMutations.js';
import type {
  AcpCapabilities,
  AcpObject,
} from '../../../shared/runtime/native/acp/capabilities.js';
export type AcpDriver = HarnessRegistration & {
  readonly binding: AcpBinding;
  readonly capabilities: AcpCapabilities;
  readonly pid: number;
  close(): Promise<void>;
};
export function createAcpDriver(options: {
  readonly store: RuntimeStore;
  readonly manager: AcpRuntimeProcessManager;
  readonly agentId: string;
  readonly target: string;
  readonly harnessInstanceId: string;
  readonly epoch: string;
  readonly workspace: ReturnType<Awaited<ReturnType<typeof createWorkspaceService>>['connect']>;
  readonly workspaceKey: string;
  readonly cwd: string;
  readonly homeDir?: string;
  readonly deadlineMs?: number;
  readonly createAuthTerminal?: (input: {
    readonly binding: AcpBinding;
    readonly method: AcpObject;
  }) => Promise<{ readonly terminalId: string; close(): Promise<void> }>;
}): Promise<AcpDriver>;
